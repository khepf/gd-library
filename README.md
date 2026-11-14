# The Tape Vault

A wall of cardboard boxes, one per year, holding live Grateful Dead (1965–1995) and Jerry Garcia (1970–1995) shows streamed from the [Internet Archive](https://archive.org).

- **Wall**: use the switch at the top to choose **Grateful Dead** or **Jerry Garcia**, then click a year's box to open it.
- **Box**: a top-down view of the open box. There's one cassette per show, showing its most-played recording and labelled with the date, venue and source. A "N versions" note means the show has other recordings to pick from in the player. Garcia tapes also carry a project label: JGB (Jerry Garcia Band), LoM (Legion of Mary), Recon (Reconstruction), G/S (Garcia & Saunders), G/K (Garcia & Kahn), OAITW (Old & In the Way), G/G (Garcia & Grisman), JGAB (Jerry Garcia Acoustic Band), Intv (interview), or JG if the project can't be identified. Type in the filter to search by date, venue, city or project.
- **Deck**: click a tape to load it into the cassette player.
  - EJECT closes the player.
  - REW goes to the previous song. If you're more than 4 seconds into a song, it restarts that song instead.
  - PLAY, PAUSE and STOP work as on a normal deck.
  - F.FWD skips to the next song.
  - Use the TAPE slider to seek and the VOL slider for volume.
  - Click any song on the J-card to jump to it.
  - The *Source* menu switches between the recordings of the same show (SBD, AUD, matrix and so on). Recordings are listed most-played first (rating breaks ties), and the most-played one loads first.

Keyboard: `Space` plays or pauses, `←`/`→` go to the previous or next song, and `Esc` ejects or goes back. Media keys and lock-screen controls also work.

## Run

There's no build step and nothing to install. You can open `index.html` directly, or serve the folder:

```
python -m http.server 8000     # then open http://localhost:8000
```

## How it works

- Year listing: `https://archive.org/advancedsearch.php`
  - Grateful Dead: `collection:GratefulDead AND year:YYYY`.
  - Jerry Garcia: `creator:"Jerry Garcia" AND collection:taperssection AND year:YYYY`. These items have no venue field, so the venue is read from the title. The project label is guessed from the recording's identifier.
  - Recordings are grouped by date into shows, and results are cached in `localStorage` for 24 hours.
- Track list: `https://archive.org/metadata/<identifier>`. The app uses the VBR MP3 files, sorted by track number.
- Audio: streamed from `https://archive.org/download/<identifier>/<file>`.
- URLs are shareable: `#/jg` shows the Garcia wall, `#/gd/1977` opens a box and `#/gd/1977/1977-05-08` loads a tape. Old links like `#/1977` still work.

## Analytics

Google Tag Manager (container `GTM-559GRVHW`) is loaded in `index.html`. The app is a single page that changes views using the URL after `#`, so on every view change it pushes a `virtual_page_view` event to the `dataLayer`. The event carries `page_path` (e.g. `/gd/1977/1977-05-08`), `page_location`, `page_title`, `artist`, `year` and `show_date`. In GTM, a GA4 Event tag named `page_view` fires on that custom event, and the Google tag has `send_page_view` set to `false` so the first page isn't counted twice.
