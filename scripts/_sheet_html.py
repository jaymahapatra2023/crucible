"""Read a Google Sheets HTML export with the standard library only."""
import sys, re
from html.parser import HTMLParser
from html import unescape

class Sheet(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self.rows, self.cells, self.buf = [], [], [], []
        self.in_cell = False
    def handle_starttag(self, tag, attrs):
        if tag == 'table': self.rows = []
        elif tag == 'tr': self.cells = []
        elif tag in ('td', 'th'): self.in_cell, self.buf = True, []
        elif tag == 'br' and self.in_cell: self.buf.append(' ')
    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.in_cell:
            self.cells.append(re.sub(r'\s+', ' ', ''.join(self.buf)).strip()); self.in_cell = False
        elif tag == 'tr': self.rows.append(self.cells)
        elif tag == 'table': self.tables.append(self.rows)
    def handle_data(self, data):
        if self.in_cell: self.buf.append(unescape(data))

def read(path):
    p = Sheet(); p.feed(open(path, encoding='utf-8', errors='replace').read()); return p.tables

if __name__ == '__main__':
    for i, t in enumerate(read(sys.argv[1])):
        print(f"--- table {i}: {len(t)} rows ---")
        for r in t[:6]:
            print('   ', [c[:28] for c in r if c != ''][:10])
