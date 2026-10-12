# Temporary helper (runs on GitHub Actions; not part of the app): finds each
# system's logo on Wikimedia Commons, records title/license/URL, downloads it.
import json, os, sys, urllib.parse, urllib.request
UA = {'User-Agent': 'OmniPC logo fetch (https://github.com/onlykappa/OmniPC)'}
API = 'https://commons.wikimedia.org/w/api.php?'
def get(params):
    with urllib.request.urlopen(urllib.request.Request(API + urllib.parse.urlencode({**params, 'format': 'json'}), headers=UA), timeout=30) as r:
        return json.load(r)
QUERIES = json.load(open(sys.argv[1]))
out_dir = sys.argv[2]; os.makedirs(out_dir, exist_ok=True)
meta = {}
for sid, spec in QUERIES.items():
    titles = list(spec.get('titles', []))
    try:
        res = get({'action': 'query', 'list': 'search', 'srnamespace': 6, 'srlimit': 8, 'srsearch': spec['search'] + ' filemime:image/svg+xml'})
        found = [h['title'] for h in res['query']['search']]
    except Exception as e:
        found = []; print(sid, 'search failed', e)
    print(f'\n== {sid}: search "{spec["search"]}" -> {found}')
    chosen = None
    for t in titles + found:
        if not t.startswith('File:'): t = 'File:' + t
        info = get({'action': 'query', 'titles': t, 'prop': 'imageinfo', 'iiprop': 'url|mime|size|extmetadata'})
        page = next(iter(info['query']['pages'].values()))
        ii = (page.get('imageinfo') or [None])[0]
        if not ii: print('   missing', t); continue
        em = ii.get('extmetadata', {})
        lic = em.get('LicenseShortName', {}).get('value', '?')
        print(f'   {t} | {ii["mime"]} {ii.get("width")}x{ii.get("height")} | {lic}')
        if chosen is None and ii['mime'] == 'image/svg+xml':
            chosen = (t, ii, lic, em)
    if chosen:
        t, ii, lic, em = chosen
        with urllib.request.urlopen(urllib.request.Request(ii['url'], headers=UA), timeout=60) as r:
            open(os.path.join(out_dir, sid + '.svg'), 'wb').write(r.read())
        meta[sid] = {'file': t, 'url': ii['descriptionurl'], 'license': lic, 'artist': em.get('Artist', {}).get('value', ''), 'credit': em.get('Credit', {}).get('value', '')[:200]}
        print('   CHOSEN', t, lic)
json.dump(meta, open(os.path.join(out_dir, 'sources.json'), 'w'), indent=2)
