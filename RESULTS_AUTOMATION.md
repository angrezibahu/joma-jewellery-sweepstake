# Automatic results — how it works

The tracker keeps itself up to date from an **internal match calendar** committed
to the repo, so nobody has to sit at the admin panel during the tournament.

## The pieces

| File | What it is |
|------|------------|
| `schedule.json` | The internal calendar: all 104 World Cup 2026 matches with UK (BST) and UTC kickoff times, venues, group/stage, and a `resultsDueUTC` for each (kickoff **+ 4 hours** ≈ 2h play + 2h buffer for extra time / penalties). |
| `results.json` | Per-match scores + winners. Written automatically by the workflow. |
| `tracker-state.json` | Derived tournament state the website reads: who's eliminated, how far each team got (which drives the bracket), and group standings. |
| `manual-results.json` | Optional manual overrides (see below). |
| `scripts/update_results.py` | The engine: fetch scores → record them → derive standings, qualification (top 2 + best 8 third-placed) and the whole knockout bracket. |
| `.github/workflows/update-results.yml` | Runs the engine hourly during the tournament and commits any changes. |

## The flow

1. The workflow runs **hourly** through June 11–30 and July 1–21 (UTC cron).
2. For every match whose `resultsDueUTC` has passed and isn't recorded yet, the
   engine pulls the final score (from the openfootball feed by default — see
   below) and writes it to `results.json`.
3. It recomputes `tracker-state.json` (eliminations + stages + standings).
4. If anything changed it commits to `main`, which triggers the existing GitHub
   Pages deploy — the live site updates on its own.

The website fetches these JSON files on load, so visitors always see current
results. The `?admin=true` panel still works: admin edits are stored as
**overrides** that take precedence over the automatic results, so you can correct
a wrong or late feed by hand at any time.

## Setup required (one-time)

**None.** Results come from
[openfootball/worldcup.json](https://github.com/openfootball/worldcup.json) — a
free, public-domain JSON file on GitHub with **no API key and no rate limit**.
The workflow already has `contents: write` permission to commit results back to
`main`, so it works out of the box.

### Data sources, in order of precedence

1. **`manual-results.json`** — hand-entered scores, always win (see below).
2. **openfootball** — the default automatic feed. Override its URL with the
   `OPENFOOTBALL_URL` env var if the path ever moves.
3. **football-data.org** *(optional)* — used only as a gap-filler if you add a
   `FOOTBALL_DATA_API_TOKEN` repository secret. It never overrides openfootball;
   it just fills any match openfootball hasn't published yet. Optionally set
   `FOOTBALL_DATA_COMPETITION` (defaults to `WC`) if the competition code differs
   on your plan. Note the free tier may not cover the World Cup at all — this is
   why openfootball is the primary feed.

GitHub's runners have open internet, so fetches work there even though they can't
be tested from a restricted dev environment.

## Manual overrides

`manual-results.json` lets you hand-enter or correct a score. It **wins over any
feed**. Keys are the match number (string) from `schedule.json`; values are the
score as `"home-away"` from the home team's perspective:

```json
{
  "1": "2-1",
  "73": "0-0"
}
```

(For a knockout that finished level after 90 mins, the feed's penalty/extra-time
result decides who progresses; for a hand-entered knockout score, enter the score
that reflects the actual decisive result.)

## Third-placed teams in the Round of 32

Eight of the twelve third-placed teams advance, and each is sent to a specific
R32 slot by a fixed official table. `schedule.json` only records the *set* of
groups each slot allows (e.g. `3A/B/C/D/F`), and several different assignments can
satisfy those sets at once — so picking one blindly can pair a third-placed team
with the wrong opponent. When that happens, the feed's real result for that team
never matches our fixture and it stays stuck on *"Awaiting result"*.

To avoid this, the engine reads the feed's actual R32 pairings and pins each
third-placed team to the slot whose seeded side the feed lists as its opponent.
A slot already filled in (against the wrong team) by an earlier, feed-blind run is
repaired the same way, as long as it hasn't kicked off yet.

## Penalty shootouts

For a knockout tie level after 90'/extra time, the engine records the shootout
score (`penaltyHome`/`penaltyAway`) alongside the `winner`, and the fixtures list
shows e.g. *"Paraguay win 4–3 on penalties"* under the level full-time score.

## A note on tiebreakers

Group ranking uses the primary FIFA criteria: points, then goal difference, then
goals scored. The rarer tiebreakers (head-to-head, disciplinary/fair-play points,
drawing of lots) aren't reproduced automatically — if one ever decides a group,
use the admin panel to set the affected teams' stage by hand.
