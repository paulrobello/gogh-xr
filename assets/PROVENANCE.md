# Asset provenance

## Method

Checked 2026-11-05 through the Wikimedia Commons API (`action=query&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=<W>`), the file wikitext (license templates, source, institution), and Wikidata labels for the depicted-work items. No image files were downloaded. Thumbnail URLs are copied verbatim from the `thumburl` field, with the `?utm_...` query tail trimmed (it is a tracking suffix).

Width snapping: the API does not return the requested widths. `iiurlwidth=4096` returned a 3840 px thumbnail and `iiurlwidth=1024` returned 1280 px, so Commons rounds up to its standard step list. The "Thumbnail URL" column holds those returned URLs, with the real width in "Returned width". A hand-built 1024 px or 4096 px URL is likely not served, though I did not fetch one to confirm. Decision (Paul, 2026-11-05): fetch Starry Night at 3840 px and never upscale it. Fetch each frame painting at 1280 px and downscale locally to 1024 px on the long edge. The Starry Night 3840 px source in `assets/scans/starry-night.jpg` is a bake input only and is never served.

All 7 chosen files are tagged public domain on the file page (`PD-Art` wrapper plus `PD-old-100*` or `PD-old-auto-expired`). None carries a photographer or reproduction license tag such as CC-BY. Commons applies the PD-Art position that faithful 2D reproductions create no new copyright.

| id | painting | version and collection | Commons file | license tags on file page (LicenseShortName / Credit) | source dimensions | target width | thumbnail URL (returned width) | description page URL | status | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| starry-night | The Starry Night (1889) | MoMA, New York. Wikitext: F612, JH1731, 73 x 92 cm | `Van Gogh - Starry Night - Google Art Project.jpg` | `PD-Art (PD-old-100-expired)`. Short name "Public domain". Credit: Google Arts & Culture | 44567 x 35291 | 3840 | https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/3840px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg (3840 px) | https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg | ok | Featured picture. MoMA accession number is not on the page. Commons serves 3840 px as the nearest snapped width to the originally planned 4096. |
| chestnut-trees-in-blossom | Blossoming Chestnut Trees (Auvers, 22-23 May 1890) | Kröller-Müller Museum, Otterlo, KM 105.479 (Faille 752, JH 1991, 63 x 50.5 cm). Inventory number comes from Wikidata Q24022705, not the file page | `1890 van Gogh Bloeiende kastanjebomen anagoria.JPG` | `PD-Art (PD-old-100-1923)`. Short name "Public domain". Credit: Kröller-Müller Museum. Photographer is the Commons user anagoria, who attached no separate license | 2736 x 3648 | 1024 | https://thumb.wikimedia.org/wikipedia/commons/thumb/8/86/1890_van_Gogh_Bloeiende_kastanjebomen_anagoria.JPG/1280px-1890_van_Gogh_Bloeiende_kastanjebomen_anagoria.JPG (1280 px) | https://commons.wikimedia.org/wiki/File:1890_van_Gogh_Bloeiende_kastanjebomen_anagoria.JPG | ok | Ambiguity on "Chestnut Trees in Blossom": Commons category "Chestnut Trees in Blossom (F751)" is a different Auvers painting, 70 x 58 cm, privately owned (file `Vincent van Gogh - Châtaigniers en fleurs.jpg`, from Sotheby's). The Kröller-Müller painting (F752) is the museum-held one, so I chose it. The brief's "Branches" (Bührle) painting was not examined. Image is a museum photo (Canon PowerShot A640), so check it for glare and perspective at the 1280 px size. Alternatives: `Van Gogh - Blühende Kastanienbäume1.jpeg` (same F752 painting, art-book repro, 2532 x 3210, `PD-old-100`). |
| les-alyscamps | Les Alyscamps / L'Allée des Alyscamps (Arles, November 1888) | Private collection, 91.7 x 73.5 cm. Sold at Sotheby's New York, 5 May 2015, lot 18. Wikidata Q4924524 | `Vincent van Gogh - L'Allée des Alyscamps.jpg` | `PD-Art (PD-old-auto-expired)`, deathyear 1890. Short name "Public domain". Credit: Sotheby's, New York, 05 May 2015, lot 18 | 1598 x 2000 | 1024 | https://thumb.wikimedia.org/wikipedia/commons/thumb/3/32/Vincent_van_Gogh_-_L%27All%C3%A9e_des_Alyscamps.jpg/1280px-Vincent_van_Gogh_-_L%27All%C3%A9e_des_Alyscamps.jpg (1280 px) | https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_L%27All%C3%A9e_des_Alyscamps.jpg | ok | Chosen over the others: single license tag, auction-house photo (not a book scan), clear provenance. Other candidates: `Van Gogh - Les Alyscamps, Allee in Arles1.jpeg` (same painting, art-book repro, 3876 x 5070); Goulandris Foundation version F568 (October 1888, only 797 x 1000); "falling leaves" F486/JH1620 (`Van Gogh - Les Alyscamps, fallende Blätter.jpeg`, 3870 x 3072, art-book repro). The Commons wikitext for F486 names the Van Gogh Museum as holder, which I could not confirm independently. The Sotheby's photo may be sharper than a book repro, but the sale-catalog image may have a color cast, so give it a visual check. |
| cafe-terrace-at-night | Café Terrace at Night / Terrace of a Café at Night (Place du Forum), Arles, September 1888 | Kröller-Müller Museum, Otterlo, 81 x 65.5 cm (dimensions and museum from the Yorck file page). Wikidata Q1025704 | `Van Gogh - Terrace of a Café at Night (Place du Forum) 1888.jpg` | `PD-art-old-100-expired` (renders as `PD-Art (PD-old-100-expired)`). Short name "Public domain". Credit/source: https://data.collectienederland.nl/page/aggregation/kroller-muller/44529 (Kröller-Müller open data). Uploader: Commons user Surajr7 | 6415 x 8000 | 1024 | https://thumb.wikimedia.org/wikipedia/commons/thumb/8/86/Van_Gogh_-_Terrace_of_a_Caf%C3%A9_at_Night_%28Place_du_Forum%29_1888.jpg/1280px-Van_Gogh_-_Terrace_of_a_Caf%C3%A9_at_Night_%28Place_du_Forum%29_1888.jpg (1280 px) | https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Terrace_of_a_Caf%C3%A9_at_Night_(Place_du_Forum)_1888.jpg | ok | Cleaner than the Yorck file. The Yorck file (`Vincent Willem van Gogh - Cafe Terrace at Night (Yorck).jpg`, 2348 x 2945) carries `PD-Art (PD-old-auto-expired)` plus an extra `PD-Art-YorckProject` tag and a DVD-ROM credit line (DirectMedia, 2002), and its permission field links an old mailing-list post. Fallback only. The chosen file has an empty Artwork description and institution field, so museum and dimensions are inferred from the KM source link and the Yorck page. Also the page says "Files uploaded by Surajr7", no photographer named. |
| bedroom | The Bedroom / Bedroom in Arles, first version (1888) | Van Gogh Museum, Amsterdam. Oil on canvas, 72 x 90 cm (per file description). Accession number is not on the page | `Vincent van Gogh - De slaapkamer - Google Art Project.jpg` | `PD-Art (PD-old-100-expired)`. Short name "Public domain". Credit: Google Arts & Culture, KwF-AdF1REQl6w | 30000 x 23803 | 1024 | https://thumb.wikimedia.org/wikipedia/commons/thumb/7/76/Vincent_van_Gogh_-_De_slaapkamer_-_Google_Art_Project.jpg/1280px-Vincent_van_Gogh_-_De_slaapkamer_-_Google_Art_Project.jpg (1280 px) | https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_De_slaapkamer_-_Google_Art_Project.jpg | ok | The description states "first version, 1888", which matches the Van Gogh Museum painting. Category: "Bedroom in Arles (Amsterdam)". |
| wheatfield-with-crows | Wheatfield with Crows (July 1890) | Van Gogh Museum, Amsterdam, accession number s0149V1962 (from the Google Art Project template) | `Vincent van Gogh - Wheatfield with crows - Google Art Project.jpg` | `PD-Art (PD-old-100-1923)`, deathyear 1890. Short name "Public domain". Credit: dwFdD5AMQfpSew at Google Cultural Institute maximum zoom level | 3508 x 1669 | 1024 | https://thumb.wikimedia.org/wikipedia/commons/thumb/b/ba/Vincent_van_Gogh_-_Wheatfield_with_crows_-_Google_Art_Project.jpg/1280px-Vincent_van_Gogh_-_Wheatfield_with_crows_-_Google_Art_Project.jpg (1280 px) | https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_Wheatfield_with_crows_-_Google_Art_Project.jpg | ok | Low-resolution Google Art scan compared with the other Google Art files (3508 px wide), but still above the 1024 px target. Aspect ratio about 2.1:1. |
| starry-night-over-the-rhone | Starry Night Over the Rhône (September 1888) | Musée d'Orsay, Paris, 72.5 x 92 cm. Wikidata Q1464531. Orsay inventory number is not on the page | `Starry Night Over the Rhone.jpg` | `PD-Art (PD-old-100-1923)`. Short name "Public domain". Credit: http://art-vangogh.com/image/Arles%20(1888-1889)/106%20Starry%20Night%20Over%20the%20Rhone.jpg | 5407 x 4191 | 1024 | https://thumb.wikimedia.org/wikipedia/commons/thumb/9/94/Starry_Night_Over_the_Rhone.jpg/1280px-Starry_Night_Over_the_Rhone.jpg (1280 px) | https://commons.wikimedia.org/wiki/File:Starry_Night_Over_the_Rhone.jpg | ok | Confirmed as the Orsay painting by the `institution` field in the file wikitext and the Commons category, not by an accession number. The image source is a third-party web gallery (art-vangogh.com), not the museum, so color fidelity is unverified. The license position is the same PD-Art as the others. |

## Could not verify

- Accession numbers for The Starry Night (MoMA), The Bedroom, and the Orsay Rhône painting are not on the file pages. Wheatfield (s0149V1962) comes from the Google Art template. The Kröller-Müller number (KM 105.479) comes from Wikidata Q24022705, not the file page.
- Exact-width thumbnails: the API returned 3840 px and 1280 px rather than 4096 px and 1024 px. I did not try fetching hand-built 1024 px or 4096 px URLs.
- Which "Chestnut Trees in Blossom" the project means. I chose the Kröller-Müller painting (F752). If the intended one is F751 (private collection), use `Vincent van Gogh - Châtaigniers en fleurs.jpg` (4096 x 4962, `PD-old-100`, Sotheby's source) instead. Not checked: the Bührle "Blossoming Chestnut Branches" painting.
- Photographic quality, glare, and color accuracy of any scan, since no image files were downloaded.
- The Café Terrace file's museum attribution rests on its source URL (Kröller-Müller open data) and its Wikidata item (Q1025704), not on a populated description.
- Which institution holds the Alyscamps "falling leaves" (F486) painting: Commons says Van Gogh Museum, but I could not confirm it.
- Whether Sotheby's, Kröller-Müller, Google, or Yorck assert separate rights on their reproductions. Only the Commons file-page tags were read.

## Painting scan hashes

Rerunning `scripts/scans/fetch.ts` regenerates the derivatives and rewrites their hashes in this table. Written by `scripts/scans/fetch.ts`. `asset-check` recomputes every hash and requires a row for every file under `public/paintings/`.

<!-- scan-hashes:start -->
| file | SHA-256 | role |
| --- | --- | --- |
| `assets/scans/starry-night.jpg` | 755176d5737a0fa6a1f90f15d066114915805fe05b5e28693dea8d9499aef464 | source (never served) |
| `public/paintings/starry-night/frame.webp` | 1d20ee35eed94e4ac2f80baf0e8dc75190a3079c2f8090592399d5e155af4dbf | runtime frame, 1024 px long edge |
| `assets/scans/chestnut-trees-in-blossom.jpg` | 3ab82c2f9179c35d48004864c82bf69bc94d014160f2544e88e8a3bfd8fcb647 | source (never served) |
| `public/paintings/chestnut-trees-in-blossom/frame.webp` | 10a162f4b8861d91619804e0ec112eeb4f01fddf4ecf3aabfce3aaac9ff5842a | runtime frame, 1024 px long edge |
| `assets/scans/les-alyscamps.jpg` | 23e565a5eee088c985c3dde167c54d320057847b4fa659950f85df907e432ec2 | source (never served) |
| `public/paintings/les-alyscamps/frame.webp` | 281c63e4ffe5db7a1ad3715071077c53a90b8abceca66483039f369f28788971 | runtime frame, 1024 px long edge |
| `assets/scans/cafe-terrace-at-night.jpg` | 735f6ff8a44866c80106f5b0d23d945df491d9137a1c9067beff8fe7feae8e65 | source (never served) |
| `public/paintings/cafe-terrace-at-night/frame.webp` | a497c0a55afbc34022761a1492bf690edf2a90d95eaf7ef5f3db6d89ae98bf99 | runtime frame, 1024 px long edge |
| `assets/scans/bedroom.jpg` | 4c5b73ea3258b9d27dfbc2cc8191eca9735649655a569d2927d22b21b57c9bd8 | source (never served) |
| `public/paintings/bedroom/frame.webp` | 5143d5d7c08900dbd0ea65e940006085f27f83b71eb39b84b676d0d8f2f4510a | runtime frame, 1024 px long edge |
| `assets/scans/wheatfield-with-crows.jpg` | cbe8c426363e3c5e0f8ff0b03d88df0e79e050f91dcd073e3e505909448ee402 | source (never served) |
| `public/paintings/wheatfield-with-crows/frame.webp` | d3d9334378a9b47867bb7a41909254ba6bc336a6bee3af523895d7d888e45cb0 | runtime frame, 1024 px long edge |
| `assets/scans/starry-night-over-the-rhone.jpg` | 8d3759a14a96b662138e355b6f88508ed64f87331373aad4cabe76e03f90a6b4 | source (never served) |
| `public/paintings/starry-night-over-the-rhone/frame.webp` | 89408a6f00550bc4b9f07772122b0f3a3a32d1df6c5df533e7c4ff7d89363e9e | runtime frame, 1024 px long edge |
<!-- scan-hashes:end -->

## Bake outputs

Derived from `assets/scans/starry-night.jpg` by `make bake` (`scripts/bake/analyze-scan.ts`), with region shapes from the hand-authored `assets/bake/starry-night/regions.json`. The bake is deterministic, so rerunning it reproduces these bytes. It rewrites this table, and `asset-check` recomputes every hash. Encodings are documented in `scripts/bake/analyze-scan.ts`.

<!-- bake-hashes:start -->
| file | SHA-256 | role |
| --- | --- | --- |
| `assets/bake/starry-night/regions.json` | 06773ec086e93287a5e635270009c758b0beef07bdcd8b875f4056f059d85043 | bake input, hand-authored |
| `public/paintings/starry-night/palette.json` | 8242fe99fe1acd445db97d47fba24f0afdb341d5ca22f29226a2f5957bb1859c | bake: 24-swatch palette |
| `public/paintings/starry-night/flow.png` | 36dfa824a20303a670941b3aa380e78496f2f3380bd6f6ebdeef2e1fecc52d97 | bake: 1024² flow field |
| `public/paintings/starry-night/regions.png` | c86235ee902a17185e63d568b18dd1837d3e3683da3339156818039bce7bf74a | bake: 1024² region ids |
<!-- bake-hashes:end -->

## Audio sources (Suno score)

Source of these notes: `docs/audio/provenance.md`. Generated by Paul on his paid Suno account (tier not stated) with model v6, from the prompt pack archived at `docs/audio/suno-prompts.md`, with no changes reported. The cue role comes from the filename Paul chose. The originals are archived unchanged, and all derivatives are made from copies. Both files carry the "made with suno" metadata comment, with encoder Lavf60.16.100. `asset-check` recomputes these hashes.

| file | SHA-256 | cue | duration | format | Suno song id | created (UTC) | model | account |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `assets/audio/source/suno/score-night.wav` | 445400c6a59f9505412a13ca350a147e47fd5073f5591d438d2328eea8c940fd | score-night | 150.000 s | pcm_s16le 48 kHz stereo | a6b8a536-7456-47fa-8c4e-24412f1dbade | 2026-11-05T23:38:08Z | Suno v6 | paid Suno account, tier not stated |
| `assets/audio/source/suno/score-gallery.wav` | 61a26bcad89ecda698d34e63ff5ce7a4b4f35f533ef19158b5a4d3fa82f4b0f9 | score-gallery | 124.080 s | pcm_s16le 48 kHz stereo | ed7681cf-c18c-4a48-9652-2006bb33cfb5 | 2026-11-05T23:39:57Z | Suno v6 | paid Suno account, tier not stated |

Approval state: source selection is done (Paul generated and delivered these). Technical preparation (seamless loops, runtime encodes), creative acceptance in the headset and release authorization are still open.

## Audio sources (ElevenLabs SFX)

Provider: the ElevenLabs Sound Effects API, `POST /v1/sound-generation`, model `eleven_text_to_sound_v2`, output `mp3_44100_128` (stereo, 44.1 kHz), via `~/.claude/skills/elevenlabs/scripts/generate.py sfx`. Paul approved the credit spend in chat on 2026-11-05. Paul chose one take per cue in the audition page: round 1 at 3:56 PM PST, and crickets take 6 in round 2. Only the selected takes are archived here, unchanged, with their original filenames. The rejected takes stay in git-ignored staging. The API returns no request or history id. ElevenLabs rights and license status has not been verified yet, and is checked before release (P7). `asset-check` recomputes these hashes.

| file | SHA-256 | cue | duration | params | generated (PST) | prompt |
| --- | --- | --- | --- | --- | --- | --- |
| `assets/audio/source/elevenlabs/wind-hill-take2.mp3` | 0b0ca2bc6c50af9a279a148bb9a715485677385a5379aabff14ad33ce949db6f | wind-hill | 25.00 s | duration 25, influence 0.5, loop | 2026-11-05 15:31:18 | Gentle night wind over a grassy hilltop, soft slow gusts rising and fading, rustling grass, steady calm bed. No whistling, no howling, no music, no voices. |
| `assets/audio/source/elevenlabs/crickets-take6.mp3` | d3a076c52a6a76bc9ef0ba7b897794718c1c711f1fba754f93e2868c0599cde1 | crickets | 25.00 s | duration 25, influence 0.6, loop | 2026-11-05 16:02 | Field crickets chirping clearly in a warm summer night meadow, several crickets close by at slightly different distances, steady rhythmic chirps, present and easy to hear but calm. Only crickets, no wind, no birds, no frogs, no voices, no music. |
| `assets/audio/source/elevenlabs/church-bell-take2.mp3` | 064b665bce72cd17a3ce3449e81237c2f2688ab1b3dc6824a52ed0633ba8b8f5 | church-bell | 10.00 s | duration 10, influence 0.5 | 2026-11-05 15:31:56 | A single distant village church bell heard across a valley at night, about three slow strikes with long natural resonant decay and faint outdoor reverb. Quiet night air, no other sounds, no music. |
| `assets/audio/source/elevenlabs/portal-whoosh-take1.mp3` | 7a10c9d66613f4d4bd1ad0b7397f3ddd3fd6c162f374b9f8d820d626f3884b1a | portal-whoosh | 2.48 s | duration 2.5, influence 0.5 | 2026-11-05 15:32:00 | Soft painterly airy swirl whoosh with a faint delicate shimmer, like passing through a painted frame. Gentle, warm and organic. Not sci-fi, no bass drop, no impact, no synth. |
| `assets/audio/source/elevenlabs/stroke-rustle-take1.mp3` | 452474a08b9819c1d81af45f40346d7fb15abdcba0a299fa0f3cc3afc09d35e1 | stroke-rustle | 1.00 s | duration 1, influence 0.5 | 2026-11-05 15:32:05 | Very soft brush bristle and paper-like rustle, a subtle gentle dry swish of a paintbrush brushing across canvas. Quiet and delicate. |

Paul's note on the church bell: the single bell is retriggered with overlapping tails when more than one chime is wanted, which is P6.5 mixer behavior. Levels vary widely between cues (stroke-rustle −45 LUFS, portal-whoosh −14 LUFS), so P6.4 sets gain at mastering. Approval state: source selection is done. Mastering, the positional mono downmix, creative acceptance in the headset and release rights are still open.

## Fonts

Copied unchanged from the mux-xr repo (`public/fonts/`), which vendored them from the official Noto source. Nothing was downloaded for this project. The perf HUD (`src/ui/perf-hud.ts`) loads the font from this local path, so troika never fetches its default CDN font. `asset-check` recomputes these hashes and requires a row for every file under `public/fonts/`.

| file | SHA-256 | source | license | bytes |
| --- | --- | --- | --- | --- |
| `public/fonts/NotoSans-Regular.ttf` | b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5 | https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf | SIL OFL 1.1 | 569208 |
| `public/fonts/OFL.txt` | 0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb | the license text distributed with NotoSans-Regular.ttf, same Noto source | SIL OFL 1.1 | 4377 |
