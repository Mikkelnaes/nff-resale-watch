#!/usr/bin/env python3
"""Small parsers used by check.sh (stdlib only; runs on python3 or python 3.x).

  parse.py catalog <file> <productId> <nameRegex>
      Reads resaleProductCatalog.json. Prints
        qty=<availableQuantity of the product|missing>
        others=<"name: qty" of every other product with qty > 0, comma separated>
  parse.py items <file>
      Reads resaleItems.json (one performance). Prints
        count=<len(resaleItems)>
        summary=<up to 4 items as "place category price", "; "-separated; tolerant
                 of unknown field names, empty if nothing recognisable>
  parse.py titles <file>
      Reads ntfy.sh JSON-lines (topic/json?poll=1&since=...). Prints the title of
      every "message" event, one per line. Malformed lines are ignored.
  parse.py shop <file> <performanceId>:<Name> [...]
      Reads the main shop's performance-selection HTML. For each performance the
      status class of the block that ends at its "check_resale_<id>" anchor is
      inspected. Prints one line per argument:  <Name>=soldout | onsale(<classes>) | unknown

Any parse problem exits 1 with a message on stderr; check.sh reports that as ERROR.
"""
import json
import re
import sys


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def products(data):
    for topic in data.get("topicWithProductsList") or []:
        for product in topic.get("products") or []:
            yield product


def cmd_catalog(path, product_id, name_re):
    data = load_json(path)
    prods = list(products(data))
    target = [p for p in prods if str(p.get("productId")) == product_id]
    if not target:
        target = [p for p in prods if re.search(name_re, p.get("name") or "", re.I)]
    chosen = target[0] if target else None
    qty = chosen.get("availableQuantity") if chosen else None
    others = [
        "%s: %s" % (p.get("name"), p.get("availableQuantity"))
        for p in prods
        if p is not chosen and (p.get("availableQuantity") or 0) > 0
    ]
    print("qty=%s" % ("missing" if qty is None else qty))
    print("others=" + ", ".join(others))


def _first(item, *keys):
    """First scalar value found under any of the keys (dotted paths allowed)."""
    for key in keys:
        cur = item
        for part in key.split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
            if cur is None:
                break
        if isinstance(cur, (str, int, float)) and str(cur).strip() != "":
            return str(cur).strip()
    return None


def describe_item(item):
    """Compact one-line description of one resale item, tolerant of unknown field
    names: 'B7 r12 s5 Kategori 2 450' (place, category, price, 'xN' if several)."""
    parts = []
    place = _first(item, "seatPath", "seatDescription")
    if place is None:
        bits = []
        area = _first(item, "area", "areaName", "section", "sectionName", "blockName", "block", "zone")
        row = _first(item, "row", "rowName", "rowNumber")
        seat = _first(item, "seat", "seatNumber", "seatName", "number")
        if area:
            bits.append(area)
        if row:
            bits.append("r" + row)
        if seat:
            bits.append("s" + seat)
        place = " ".join(bits) or None
    if place:
        parts.append(place)
    cat = _first(item, "seatCategory", "seatCategoryName", "seatCategory.name", "categoryName")
    if cat:
        parts.append(cat)
    price = _first(item, "price", "unitAmount", "unitPrice", "amount", "priceWithCharge")
    if price:
        parts.append(price)
    qty = _first(item, "availableQuantity", "quantity", "remainingQuantity")
    if qty and qty not in ("1", "1.0"):
        parts.append("x" + qty)
    return " ".join(parts)


def summarize_items(items, max_items=4, max_len=220):
    descs = [d for d in (describe_item(i) for i in items if isinstance(i, dict)) if d]
    shown = descs[:max_items]
    if len(descs) > max_items:
        shown.append("+%d more" % (len(descs) - max_items))
    text = "; ".join(shown)
    if len(text) > max_len:
        text = text[: max_len - 3].rstrip() + "..."
    return text


def cmd_items(path):
    data = load_json(path)
    items = data.get("resaleItems") or []
    print("count=%d" % len(items))
    print("summary=" + summarize_items(items))


def cmd_shop(path, matches):
    with open(path, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
    anchors = [(m.start(), m.group(1)) for m in re.finditer(r'id="check_resale_(\d+)"', html)]
    status = {}
    prev = 0
    for pos, pid in anchors:
        found = re.findall(r'class="availability_status ([^"]*)"', html[prev:pos])
        status[pid] = found[-1].strip() if found else None
        prev = pos
    for arg in matches:
        pid, name = arg.split(":", 1)
        st = status.get(pid)
        if st is None:
            print("%s=unknown" % name)
        elif "sold_out" in st.split():
            print("%s=soldout" % name)
        else:
            print("%s=onsale(%s)" % (name, st))


def cmd_titles(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("event", "message") == "message" and msg.get("title"):
                print(msg["title"])


def main(argv):
    # Plain "\n" line endings even on Windows, where text-mode stdout would emit "\r\n".
    try:
        sys.stdout.reconfigure(newline="\n")
    except (AttributeError, ValueError):
        pass
    try:
        if argv[0] == "catalog":
            cmd_catalog(argv[1], argv[2], argv[3])
        elif argv[0] == "items":
            cmd_items(argv[1])
        elif argv[0] == "titles":
            cmd_titles(argv[1])
        elif argv[0] == "shop":
            cmd_shop(argv[1], argv[2:])
        else:
            raise SystemExit("unknown command %r" % argv[0])
    except (OSError, ValueError, IndexError, KeyError, AttributeError) as exc:
        sys.stderr.write("%s: %s\n" % (type(exc).__name__, exc))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
