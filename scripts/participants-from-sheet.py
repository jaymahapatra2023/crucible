#!/usr/bin/env python3
"""
Turn a Google Sheets HTML export of the registration form into a participant CSV.

The registration form is a Google Form, and its responses sheet is exported as HTML rather than
CSV because that is what the browser's Save Page gives you. Standard library only: no pandas, no
openpyxl, nothing to install on a laptop an hour before an event.

Columns are found by HEADER TEXT, not by position. A Google Form grows a column every time
somebody adds a question, and a script keyed to "column E" silently loads phone numbers into the
email field the first time that happens.

Usage:  scripts/participants-from-sheet.py <export.html> [out.csv]
"""
import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _sheet_html import read  # noqa: E402

EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

WANTED = {
    'first': ('first name',),
    'last': ('last name',),
    'email': ('email',),
    'org': ('school name', 'college / university'),
    'phone': ('phone',),
}


def find_columns(header: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for i, cell in enumerate(header):
        low = cell.strip().lower()
        if not low:
            continue
        for key, needles in WANTED.items():
            if key in found:
                continue
            if any(n in low for n in needles):
                found[key] = i
    missing = [k for k in ('first', 'email') if k not in found]
    if missing:
        raise SystemExit(f"could not find column(s) {missing} in the header: {header}")
    return found


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'participants.csv'

    tables = read(src)
    if not tables:
        raise SystemExit(f"no table found in {src}")
    rows = max(tables, key=len)

    # The header is the first row that names an email column; row 0 is Google's A/B/C letters.
    head_at = next((i for i, r in enumerate(rows[:5])
                    if any('email' in c.lower() for c in r if c)), 1)
    cols = find_columns(rows[head_at])

    def cell(row: list[str], key: str) -> str:
        i = cols.get(key)
        return row[i].strip() if i is not None and i < len(row) else ''

    people, problems = [], []
    for row in rows[head_at + 1:]:
        if not any(c.strip() for c in row[1:6] if c):
            continue
        name = ' '.join(x for x in (cell(row, 'first'), cell(row, 'last')) if x)
        email = cell(row, 'email')
        if not name or not email:
            problems.append(f"row {row[0] if row else '?'}: name={name!r} email={email!r}")
            continue
        if not EMAIL.match(email):
            problems.append(f"{name}: {email!r} is not an email address")
            continue
        people.append({
            'full_name': name, 'email': email,
            'organisation': cell(row, 'org'), 'phone': cell(row, 'phone'),
        })

    seen: dict[str, str] = {}
    for p in people:
        key = p['email'].lower()
        if key in seen:
            problems.append(f"{p['full_name']} repeats the address already used by {seen[key]}")
        seen[key] = p['full_name']

    with open(out, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['full_name', 'email', 'organisation', 'phone'])
        w.writeheader()
        w.writerows(people)

    print(f"{len(people)} participants -> {out}")
    if problems:
        print(f"{len(problems)} problem(s), none of them loaded:")
        for p in problems:
            print('  -', p)


if __name__ == '__main__':
    main()
