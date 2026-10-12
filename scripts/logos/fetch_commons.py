# Temporary helper (runs on GitHub Actions; not part of the app): finds each
# system's logo on Wikimedia Commons, records title/license/URL, downloads it.
import json, os, sys, urllib.error, urllib.parse, urllib.request
UA = {'User-Agent': 'OmniPC logo fetch (https://github.com/onlykappa/OmniPC)'}
API = 'https://commons.wikimedia.org/w/api.php?'
import time
def fetch(url):
    for attempt in range(6):
        time.sleep(1.2)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError('rate limited: ' + url)
def get(params):
    return json.loads(fetch(API + urllib.parse.urlencode({**params, 'format': 'json'})))
QUERIES = json.load(open(sys.argv[1]))
out_dir = sys.argv[2]; os.makedirs(out_dir, exist_ok=True)
meta = {}
for sid, spec in QUERIES.items():
    titles = list(spec.get('titles', []))
    found = []
    def pick(cands):
        for t in cands:
            if not t.startswith('File:'): t = 'File:' + t
            info = get({'action': 'query', 'titles': t, 'prop': 'imageinfo', 'iiprop': 'url|mime|size|extmetadata'})
            page = next(iter(info['query']['pages'].values()))
            ii = (page.get('imageinfo') or [None])[0]
            if not ii: print('   missing', t); continue
            em = ii.get('extmetadata', {})
            lic = em.get('LicenseShortName', {}).get('value', '?')
            print(f'   {t} | {ii["mime"]} {ii.get("width")}x{ii.get("height")} | {lic}')
            if ii['mime'] == 'image/svg+xml': return (t, ii, lic, em)
        return None
    chosen = pick(titles)
    if chosen: titles = []
    try:
        if not chosen:
            res = get({'action': 'query', 'list': 'search', 'srnamespace': 6, 'srlimit': 5, 'srsearch': spec['search'] + ' filemime:image/svg+xml'})
            found = [h['title'] for h in res['query']['search']]
    except Exception as e:
        found = []; print(sid, 'search failed', e)
    print(f'\n== {sid}: search "{spec["search"]}" -> {found}')
    if not chosen: chosen = pick(found)
    if chosen:
        t, ii, lic, em = chosen
        open(os.path.join(out_dir, sid + '.svg'), 'wb').write(fetch(ii['url']))
        meta[sid] = {'file': t, 'url': ii['descriptionurl'], 'license': lic, 'artist': em.get('Artist', {}).get('value', ''), 'credit': em.get('Credit', {}).get('value', '')[:200]}
        print('   CHOSEN', t, lic)
json.dump(meta, open(os.path.join(out_dir, 'sources.json'), 'w'), indent=2)
