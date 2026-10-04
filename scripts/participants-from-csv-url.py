#!/usr/bin/env python3
"""
Pull participants from a Google Sheet, keeping only the rows marked as registered.

Reads a CSV URL — either a "Publish to web" link or the `export?format=csv` endpoint of a sheet
shared as "anyone with the link can view". Standard library only.

Rows are filtered by a GATE column: a row is taken only when that column says yes. The gate is
named by spreadsheet letter (C) or by header text ("Registered"), because a Google Form grows a
column whenever somebody adds a question and a script keyed to a position silently reads the
wrong field the first time that happens.

Idempotent by design: it writes a CSV and the importer treats an address it already holds as
EXISTING, so running this every few minutes adds the new arrivals and touches nobody else.

Usage:
  scripts/participants-from-csv-url.py <csv-url> [out.csv] [--gate C] [--yes Yes,Y,TRUE]
"""
import csv
import io
import re
import sys
import urllib.error
import urllib.request

EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

# Header text that identifies each field we need. Matched case-insensitively as a substring.
WANTED = {
    'first': ('first name',),
    'last': ('last name',),
    'email': ('email',),
    'org': ('school name', 'college / university', 'university', 'college'),
    'phone': ('phone',),
}


def letter_to_index(letter: str) -> int:
    """A -> 0, B -> 1, ... AA -> 26. Spreadsheet lettering, not zero-based counting."""
    n = 0
    for ch in letter.strip().upper():
        if not ch.isalpha():
            raise SystemExit(f"{letter!r} is not a column letter")
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def fetch(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            body = r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        raise SystemExit(
            f"the sheet refused the request ({e.code} {e.reason}).\n"
            "It is not readable without signing in. Either publish the tab to the web as CSV,\n"
            "or share the sheet as 'anyone with the link can view'.")
    except Exception as e:  # noqa: BLE001 — any transport failure is the same answer here
        raise SystemExit(f"could not read the sheet: {type(e).__name__}: {e}")
    if '<html' in body[:400].lower():
        raise SystemExit(
            "the sheet returned a web page rather than CSV, which means it is not public.\n"
            "Publish the tab to the web as CSV, or share it as 'anyone with the link can view'.")
    return body


def find_columns(header: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for i, cell in enumerate(header):
        low = cell.strip().lower()
        if not low:
            continue
        for key, needles in WANTED.items():
            if key not in found and any(n in low for n in needles):
                found[key] = i
    missing = [k for k in ('first', 'email') if k not in found]
    if missing:
        raise SystemExit(f"could not find column(s) {missing}. Header was: {header}")
    return found


def resolve_gate(header: list[str], gate: str) -> int:
    """By letter if it looks like one, otherwise by header text."""
    if re.fullmatch(r'[A-Za-z]{1,2}', gate.strip()):
        return letter_to_index(gate)
    low = gate.strip().lower()
    for i, cell in enumerate(header):
        if low in cell.strip().lower():
            return i
    raise SystemExit(f"no column matches {gate!r}. Header was: {header}")


def main() -> None:
    args = [a for a in sys.argv[1:]]
    if not args:
        raise SystemExit(__doc__)
    url = args.pop(0)
    out = 'participants.csv'
    gate = 'C'
    yeses = {'yes', 'y', 'true', '1', 'registered', 'checked in'}

    positional = []
    while args:
        a = args.pop(0)
        if a == '--gate':
            gate = args.pop(0)
        elif a == '--yes':
            yeses = {v.strip().lower() for v in args.pop(0).split(',') if v.strip()}
        else:
            positional.append(a)
    if positional:
        out = positional[0]

    rows = list(csv.reader(io.StringIO(fetch(url))))
    if not rows:
        raise SystemExit("the sheet is empty")

    # The header is the first row naming an email column; a Form sheet sometimes has a title row.
    head_at = next((i for i, r in enumerate(rows[:5])
                    if any('email' in c.lower() for c in r)), 0)
    header = rows[head_at]
    cols = find_columns(header)
    gate_at = resolve_gate(header, gate)
    print(f"gate column: {gate} -> {header[gate_at]!r}" if gate_at < len(header) else f"gate: {gate}")

    def cell(row: list[str], key: str) -> str:
        i = cols.get(key)
        return row[i].strip() if i is not None and i < len(row) else ''

    people, skipped, problems = [], 0, []
    for row in rows[head_at + 1:]:
        if not any(c.strip() for c in row):
            continue
        flag = row[gate_at].strip().lower() if gate_at < len(row) else ''
        if flag not in yeses:
            skipped += 1
            continue
        name = ' '.join(x for x in (cell(row, 'first'), cell(row, 'last')) if x)
        email = cell(row, 'email')
        if not name or not EMAIL.match(email):
            problems.append(f"name={name!r} email={email!r}")
            continue
        people.append({
            'full_name': name, 'email': email,
            'organisation': cell(row, 'org'), 'phone': cell(row, 'phone'),
        })

    # Repeated addresses are DROPPED here rather than passed on.
    #
    # The importer refuses a whole file if any row is unusable, which is right for a careful
    # one-off load and wrong for a live sync: a sheet accumulates duplicates all morning, and one
    # person entered twice must not stop the other eighteen arrivals from being added. It did,
    # silently, until this was fixed — the import reported what it WOULD do and then wrote
    # nothing.
    seen: dict[str, str] = {}
    unique = []
    for p in people:
        key = p['email'].lower()
        if key in seen:
            problems.append(f"{p['full_name']} repeats the address of {seen[key]} — row skipped")
            continue
        seen[key] = p['full_name']
        unique.append(p)
    people = unique

    with open(out, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['full_name', 'email', 'organisation', 'phone'])
        w.writeheader()
        w.writerows(people)

    print(f"{len(people)} registered -> {out}   ({skipped} not marked yes)")
    if problems:
        print(f"{len(problems)} row(s) not loaded:")
        for p in problems:
            print('  -', p)


if __name__ == '__main__':
    main()
