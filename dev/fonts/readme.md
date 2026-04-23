# Fonts Overview
This directory contains development resources for the fonts used by the application. `raw/` holds the third-party source fonts, and `script/` holds the bash scripts that process them into the final `.woff` files shipped to the live site. Neither is used by the main application or automated tests directly.

# Font Sources
The "raw" fonts live in `raw/`. These are fonts downloaded from various 3rd party sources, which are processed using FontForge and HarfBuzz into the final files.

## Default Fonts

- Carlito
	- Source: Google Fonts
		- https://fonts.google.com/specimen/Carlito
	- Files:
		- `Carlito-Regular.ttf`
		- `Carlito-Bold.ttf`
		- `Carlito-Italic.ttf`
		- `Carlito-BoldItalic.ttf`
- Century (C059)
	- Source: URW Base 35 Fonts
	- Files:
		- `C059-Roman.otf`
		- `C059-Bold.otf`
		- `C059-Italic.otf`
		- `C059-BdIta.otf`
- Courier (Nimbus Mono)
	- Source: URW Base 35 Fonts
		- mupdf: `resources/fonts/urw/`
	- Files:
		- `urw/NimbusMonoPS-Regular.cff`
		- `urw/NimbusMonoPS-Bold.cff`
		- `urw/NimbusMonoPS-Italic.cff`
		- `urw/NimbusMonoPS-BoldItalic.cff`
- Garamond
	- Source: Google Fonts
		- https://fonts.google.com/specimen/EB+Garamond
	- Files:
		- `EBGaramond-Regular.ttf`
		- `EBGaramond-Bold.ttf`
		- `EBGaramond-Italic.ttf`
		- `EBGaramond-BoldItalic.ttf`
- Gothic
	- Source: URW Base 35 Fonts
	- Files:
		- `URWGothic-Book.otf`
		- `URWGothic-Demi.otf`
		- `URWGothic-BookOblique.otf`
		- `URWGothic-DemiOblique.otf`
- Nimbus Sans
	- Source: URW Base 35 Fonts
		- mupdf: `resources/fonts/urw/`
	- Files:
		- `urw/NimbusSans-Regular.cff`
		- `urw/NimbusSans-Bold.cff`
		- `urw/NimbusSans-Italic.cff`
		- `urw/NimbusSans-BoldItalic.cff`
- Palatino (P052)
	- Source: URW Base 35 Fonts
	- Files:
		- `P052-Roman.otf`
		- `P052-Bold.otf`
		- `P052-Italic.otf`
		- `P052-BoldItalic.otf`
- Times (Nimbus Roman)
	- Source: URW Base 35 Fonts
		- mupdf: `resources/fonts/urw/`
	- Files:
		- `urw/NimbusRoman-Regular.cff`
		- `urw/NimbusRoman-Bold.cff`
		- `urw/NimbusRoman-Italic.cff`
		- `urw/NimbusRoman-BoldItalic.cff`
- Dingbats (`urw/Dingbats.cff`)
	- Source: URW Base 35 Fonts
		- mupdf: `resources/fonts/urw/Dingbats.cff`
	- Built by `script/generate_fonts.sh` without any subsetting (kept as-is from the source) and written to `prod/Dingbats.woff`.

# Font Generation
The fonts included in the live site are standardized versions of the raw fonts found in `raw/`.  The appearance of the fonts should not change, however modifications are made to either (1) reduce file sizes or (2) standardize the fonts to make working with them easier.  For example, all files are converted to `.woff` (compressed and optimized for web) and subset to include a standard set of characters.  The following 4 bash scripts are used to create the fonts used by the application.

1. `generate_fonts.sh`
	1. Generate fonts.
2. `check_fonts.sh`
	1. Check that all desired characters were actually included in the final fonts.
	2. This is necessary because the `hb-subset` command used by `generate_fonts.sh` does not fail or throw a warning if character in the list to subset to is not in the font.

# Glyph Sets
The vast majority of the glyphs in the raw fonts are unused by most users.  Therefore, to avoid unnecessary network traffic, subset fonts are created that include different sets of glyphs.  By default only the `Latin` set is loaded, and the full set is loaded on an as-needed basis.

- `Latin` Set
	- Basic Latin characters plus Latin diacritics (`charSetLatinBase.txt` + `charSetLatinExt.txt`).
- `All`
	- For URW Base 35 fonts (Nimbus\*, C059, P052, URWGothic): every codepoint present in the source font.  The URW sources are small enough that keeping everything is cheap.
	- For Carlito and EBGaramond: `Latin` + Cyrillic + Greek (`charSetCyrillic.txt` + `charSetGreek.txt`).  Their TTF sources carry large tails of rarely-used glyphs, so they stay subset to keep file sizes reasonable.
	- In both cases ligature features are still stripped.

Note that CJK fonts are handled in a different manner, as these require entirely separate font files.

`Dingbats` is a special case: it ships as a single `Dingbats.woff` with no `Latin`/`All` split and no subsetting at all (the URW source is already small).

# Reproducibility
`generate_fonts.sh` sets `SOURCE_DATE_EPOCH=0` before invoking `hb-subset` and `fontforge` so that timestamp-sensitive tables (`head.modified`, FontForge's own `FFTM` table) are written with zero values.  Under this setting both tools produce byte-identical output across runs, which keeps Git diffs to just the glyph changes we actually intend.
