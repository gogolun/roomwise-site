"""Adds content hashes to the portal's CSS and JS links (e.g. portal.js?v=93a2ff0690).

The site's files are cached by browsers for hours, so without this a shop owner's phone
can keep showing an old portal after an update. Run before committing portal changes:

    python3 tools/version_assets.py
"""
import hashlib
import re
from pathlib import Path

site = Path(__file__).parent.parent
page = site / "portal" / "index.html"
html = page.read_text()
for ref in ["../styles.css", "portal.css", "catalog.js", "portal.js"]:
    content = (page.parent / ref).resolve().read_bytes()
    # An empty file is never intended and would publish a broken portal.
    assert len(content) > 100, f"{ref} is empty or nearly empty; not versioning it"
    digest = hashlib.sha256(content).hexdigest()[:10]
    html, count = re.subn(r'(["\'])' + re.escape(ref) + r'(\?v=[0-9a-f]+)?\1', rf"\1{ref}?v={digest}\1", html)
    assert count == 1, f"{ref} referenced {count} times in {page}"
page.write_text(html)
print("versioned portal assets")
