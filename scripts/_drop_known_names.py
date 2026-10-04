#!/usr/bin/env python3
"""
Remove rows whose person is already on the roster under a DIFFERENT address.

The sync matches on email, which is right: an address is an identity and a name is not. But a
Google Sheet accumulates the same person twice with two addresses, and Google's published CSV is
eventually consistent — two fetches seconds apart genuinely return different copies — so "wait
for the cache to settle, then import" does not work. A row deleted from the sheet can arrive once
more from a stale edge cache minutes later.

So the sync refuses to create a SECOND row for a name it already holds. The first address wins,
the later one is reported for a human to resolve, and a stale cache can no longer quietly fork a
person into two participants who could end up on two different teams.

This never blocks a genuinely new person: a name nobody holds is passed straight through.

Also drops anybody on the exclusion list, for the same reason: somebody who has LEFT keeps
arriving from a stale cache otherwise, and deleting them from the roster looks like it worked
right up until the next pass.

Usage:  _drop_known_names.py <in.csv> <out.csv> <roster.txt> [exclude.txt]
        roster.txt is "name|email" per line.
"""
import csv
import re
import sys


def norm(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def main() -> None:
    src, dst, roster_path = sys.argv[1], sys.argv[2], sys.argv[3]
    exclude_path = sys.argv[4] if len(sys.argv) > 4 else None

    excluded: set[str] = set()
    if exclude_path:
        try:
            for line in open(exclude_path):
                line = line.split('#', 1)[0].strip().lower()
                if line:
                    excluded.add(line)
        except FileNotFoundError:
            pass

    held: dict[str, str] = {}
    for line in open(roster_path):
        if '|' not in line:
            continue
        name, email = line.rstrip('\n').split('|', 1)
        held.setdefault(norm(name), email.strip())

    rows = list(csv.DictReader(open(src)))
    keep, dropped, gone = [], [], []
    for r in rows:
        if (r.get('email') or '').strip().lower() in excluded:
            gone.append(r.get('full_name', ''))
            continue
        key = norm(r.get('full_name', ''))
        existing = held.get(key)
        if existing is not None and existing.lower() != (r.get('email') or '').strip().lower():
            dropped.append((r.get('full_name', ''), r.get('email', ''), existing))
            continue
        keep.append(r)

    with open(dst, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['full_name', 'email', 'organisation', 'phone'])
        w.writeheader()
        for r in keep:
            w.writerow({k: r.get(k, '') for k in w.fieldnames})

    if gone:
        print(f"  {len(gone)} row(s) on the exclusion list, not added: {', '.join(gone)}")
    if dropped:
        print(f"  {len(dropped)} row(s) held back — already on the roster under another address:")
        for name, sheet_email, db_email in dropped:
            print(f"    {name}: sheet says {sheet_email}, roster holds {db_email}")


if __name__ == '__main__':
    main()
