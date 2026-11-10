#!/usr/bin/env bash
# Live health check for the Samhithe backends. Writes ops/status.md and pushes it to the "ops-status" branch.
# Reads only public endpoints – no passwords, no family data.
set -u
NOTE="${1:-manual}"
BOOKING="https://script.google.com/macros/s/AKfycbzw67eOs-JR0uudjn1Yu_Z9pp0Zy5-k7r59Glr8W9PoYSTGnGGId2N3mtlUqFlnoMc2/exec"
ADMIN="https://script.google.com/macros/s/AKfycbzHIlWBg_k_9V4DE3zYat7ltuOKWCysWc083ZGYLuuhh0L6g94lFztofkKt-GYrJiIM/exec"
OUT=$(mktemp)

t0=$(date +%s%3N); curl -sSL --max-time 60 "$BOOKING?action=slots" -o /tmp/slots.json; t1=$(date +%s%3N)
curl -sSL --max-time 60 "$ADMIN" -o /tmp/admin.json; t2=$(date +%s%3N)
curl -sSL --max-time 60 -X POST -H 'Content-Type: text/plain' --data '{"action":"data","token":"0000000000000000000000000000000000000000000000000000000000000000"}' "$ADMIN" -o /tmp/auth.json
for p in / /booking/ /admin/ /admin/sw.js; do printf '%s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' "https://www.samhithe.in$p")"; done > /tmp/site.txt

python3 - "$NOTE" $((t1-t0)) $((t2-t1)) > "$OUT" <<'PY'
import json, sys, datetime
note, tb, ta = sys.argv[1], sys.argv[2], sys.argv[3]
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30))).strftime('%a %d %b %Y, %I:%M %p IST')
print(f"# Samhithe health check\n\n**When:** {now}  \n**Trigger:** {note}\n")
def load(p):
    try: return json.load(open(p))
    except Exception as e: return {"ok": False, "message": f"unreadable: {e}"}
s, a, au = load('/tmp/slots.json'), load('/tmp/admin.json'), load('/tmp/auth.json')
print("| Check | Result |\n|---|---|")
print(f"| Booking engine (slots) | {'OK' if s.get('ok') else 'FAIL – ' + str(s.get('message'))} · {tb} ms |")
print(f"| Admin backend | {'OK' if a.get('ok') else 'FAIL'} · {ta} ms |")
print(f"| Admin rejects bad session | {'OK' if au.get('code') == 'AUTH' else 'UNEXPECTED: ' + json.dumps(au)[:80]} |")
for line in open('/tmp/site.txt'):
    p, code, t = line.split()
    print(f"| www.samhithe.in{p} | {'OK' if code == '200' else 'FAIL'} {code} · {t} |")
if s.get('ok'):
    print(f"\n## Bookable days (next {len(s['days'])} days) – session {s.get('minutes')} min, ₹{s.get('price')}\n")
    print("| Date | Day | Free slots |\n|---|---|---|")
    for d in s['days']:
        sl = d['slots']
        print(f"| {d['date']} | {d['weekday']} | {'**Full / not available**' if not sl else ', '.join(x['label'] for x in sl)} |")
PY

cat "$OUT"
git config user.name "samhithe-bot"; git config user.email "actions@users.noreply.github.com"
git fetch -q origin ops-status 2>/dev/null && git checkout -q -B ops-status origin/ops-status || git checkout -q --orphan ops-status
git rm -rqf . >/dev/null 2>&1 || true
mkdir -p ops && cp "$OUT" ops/status.md
git add ops/status.md && git commit -qm "Health check: $NOTE" && git push -q origin ops-status
