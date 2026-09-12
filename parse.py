#!/usr/bin/env python3
"""Small parsers used by check.sh (stdlib only; runs on python3 or python 3.x).

  parse.py catalog <file> <productId> <nameRegex>
      Reads resaleProductCatalog.json. Prints
        qty=<availableQuantity of the product|missing>
        others=<"name: qty" of every other product with qty > 0, comma separated>
  parse.py items <file>
      Reads resaleItems.json (one performance). Prints  count=<len(resaleItems)>
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


def cmd_items(path):
    data = load_json(path)
    print("count=%d" % len(data.get("resaleItems") or []))


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
