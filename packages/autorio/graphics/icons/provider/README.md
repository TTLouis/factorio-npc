# Provider avatars

The console's top-left button wears the avatar of whichever vendor is behind the
model SGLuna is currently calling. `src/task_board_provider.ts` resolves the
provider id from the configured model identifier, and `data.lua` declares one
`sprite` prototype per file.

**The artwork in this folder is AI-generated.** It is not the work of a human
illustrator, and it is not any vendor's official artwork - each avatar is an
original character wearing that vendor's mark as a hair clip. Say so anywhere
these are shown or redistributed.

| files | shown for models matching |
| --- | --- |
| `claude-1..4.png` | `claude`, `anthropic`, `sonnet`, `opus`, `haiku` |
| `deepseek-1..4.png` | `deepseek` |
| `qwen-1..4.png` | `qwen`, `qianwen`, `tongyi` |
| `gemini-1..4.png` | `gemini`, `google` |
| `openai-1..4.png` | `openai`, `chatgpt`, `gpt-`, `gpt4`, `gpt3`, `o1-`, `o3-`, `o4-` |

Matching is by substring, in that order, so a routed identifier like
`openai-compatible/deepseek-chat` resolves to the vendor that actually answers.
No key is a speed tier: every vendor ships a "flash", so the word says nothing
about who is answering.

A model that matches none of them keeps the button's default sprite. There is no
house avatar for that case on purpose.

## Variants

Each provider has several avatars, and a player is rolled one when they join, so
the console does not look identical every session. The roll is per player and
lives in `storage`, because the console is synchronized game state: every peer
has to draw the same button for the same player. It is deliberately not
`math.random`, which would advance the map's synchronized RNG from GUI code.

Variant counts appear in two places and must agree: `variants` in
`src/task_board_provider.ts` and the table in `data.lua`. A resolver count
higher than the declared one leaves a blank button for whichever players rolled
the missing variant - a bug that only shows up for some players in some
sessions. `task_board_ui_layout.test.ts` compares the two.

## Format

Every file here is **128x128 RGBA**. The mod-GUI button is fixed at 48 GUI
units, while `data.lua` draws every provider canvas at **40 GUI units**
(`40 / 128`). That leaves four units of breathing room on each side and is
large enough for the character art to read without letting any one provider
change the button geometry.

The data stage deliberately uses exactly one scale for every provider and
variant. Differences in apparent face/head size are corrected in the imported
asset, not with provider-specific runtime UI code.

## Importing artwork

```bash
python packages/autorio/scripts/import_provider_icon.py <source-image> <provider-id-and-variant> [options]
```

It accepts any size and keys a white background to transparent. `--check`
reports what it would produce without writing.

**Keeping a set consistent is the whole job**, and it takes two rules.

*The head sets the scale.* By default the script scales each source so the
measured head is 102 of the icon's 128 pixels, which is what makes twenty
avatars drawn at twenty different sizes look like one set. Squaring each figure
by its own bounding box instead scales a short drawing up more than a tall one;
that produced heads ranging from 83px to 106px across five avatars drawn at the
same scale.

*The bottom edge sets the placement.* Scaling on the head alone still leaves
each figure wherever its own costume happens to end, so one whose art stops
early floats above the button's edge while its neighbours are cut flush by it -
a 9px gap across the set, plainly visible at button size. Each figure is pushed
down onto the edge, never pulled up: one already running past it is flush there
by definition, and pulling it up would drag its head out of frame. `--anchor`
therefore only positions a figure that already reaches the bottom.

The script prints the measured head width and bottom edge of every import, so
drift in either is visible as it happens. A figure needing more than a 15% push
to reach the edge is reported rather than silently shoved into place - that
means the artwork is proportioned unlike the rest of the set.

*Where the measurement loses.* The head is measured by silhouette, so a
voluminous hairstyle or a wide hair ornament can read as head and make that
figure look smaller after automatic normalization. Those exceptions now live in
`scripts/provider_icon_optical.json`, which the importer applies automatically.
Keeping the optical corrections in one manifest makes them reproducible and
keeps the Factorio runtime/provider resolver free of avatar-specific branches.

The current manifest carries the three known silhouette outliers:

| avatar | scale | why |
| --- | --- | --- |
| `claude-2` | 1.10 | bonnet and side curls read as head |
| `deepseek-2` | 1.10 | hair volume plus the hairpin |
| `gemini-1` | 1.10 | the arc and star ornaments sit outside the head |

The manifest can also record small `offset_x` / `offset_y` corrections in
128px-canvas units. CLI `--scale`, `--offset-x`, and `--offset-y` override
the manifest for one import; `--no-optical-adjustment` disables it.

Options worth knowing:

- `--head N` - target head width in the finished icon. The default, 102.
- `--slice X0:X1` - take one figure out of a multi-figure sheet by pixel column.
- `--frame SIDE` - fixed source box instead of head-normalized. Only equivalent
  when every figure is drawn at one scale, as on a single sheet.
- `--anchor F` - where the head's widest row sits vertically, default 0.55.
- `--no-baseline` - leave the figure where the head anchor puts it.
- `--scale F` - override the manifest's optical scale for one import.
- `--offset-x N` / `--offset-y N` - override the manifest's small baked-in
  placement correction, in 128px-canvas units.
- `--no-optical-adjustment` - ignore the optical manifest for a diagnostic
  import.
- `--keep-top F` - for a lone portrait with no set to match.

The current set came from one five-figure sheet plus three sets of individual
square images, all imported at the default head width:

```bash
# sheet, 2172x724, five figures
python packages/autorio/scripts/import_provider_icon.py "$SHEET" openai-1 --slice 0:425
python packages/autorio/scripts/import_provider_icon.py "$SHEET" claude-1 --slice 438:866
# ... deepseek-1 --slice 878:1300, gemini-1 --slice 1310:1735, qwen-1 --slice 1748:2171

# individual squares
python packages/autorio/scripts/import_provider_icon.py "$IMAGE" openai-2

# optical exceptions such as claude-2 are applied from the manifest
python packages/autorio/scripts/import_provider_icon.py "$IMAGE" claude-2
```

## Visual QA contact sheet

Numeric head measurements are useful, but the final criterion is the 48px
button. Generate a sheet that renders every committed avatar exactly as a
40px provider canvas centered inside a 48px slot:

```bash
python packages/autorio/scripts/make_provider_icon_contact_sheet.py
```

It writes `provider-icons-contact-sheet.png` in the current directory. Check
the rows for comparable apparent head/face size and baseline before accepting a
new avatar. If one still reads too small/large, update
`scripts/provider_icon_optical.json` and re-import it rather than adding a
runtime provider special case.

## Archived larger copies

`packages/autorio/assets/provider/` holds the same twenty avatars at 256x256,
framed identically. They are outside `graphics/`, so the mod build does not ship
them - `graphics/` is what gets copied into `dist/`. They exist for anything
outside the button that wants more pixels.

Regenerate one with the same command plus `--size 256 --out-dir`:

```bash
python packages/autorio/scripts/import_provider_icon.py "$IMAGE" openai-2   --size 256 --out-dir packages/autorio/assets/provider
```

Framing is size-independent, so the 256 copy is the 128 one with more pixels
rather than a differently cropped picture. Note what the sources support: the
figures cut out of the five-figure sheet carry about 500 source pixels across
the crop square, so they still downscale cleanly into 256 but would be roughly
1:1 at 512. The individual square sources carry about 1300 and have room to
spare.

## Placeholders

`scripts/make_provider_placeholders.py <provider-id>` writes a flat brand-color
plate for an id that has no artwork yet. It exists because the data stage has no
file-exists test and treats a missing sprite file as a hard load failure. It
refuses to overwrite an existing file unless you pass `--force`, so it cannot
quietly replace real artwork.

## Adding a provider

1. Add the id, its match keys, and its `variants` count to `PROVIDERS` in
   `src/task_board_provider.ts`.
2. Add the id and the same count to the table in `data.lua`.
3. Commit that many 128x128 PNGs here as `<id>-1.png` and up.

All three are required. An id or count in `data.lua` with no committed PNG stops
the mod from loading; a resolver id or count with no prototype leaves the button
blank or on its default sprite.
