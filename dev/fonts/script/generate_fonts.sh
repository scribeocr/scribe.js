raw_fonts_dir="raw"
## Write directly into the shipped fonts directory at the repo root so there is no
## intermediate prod/ artifact to keep in sync.
proc_fonts_dir="../../fonts"
all_fonts=1
parent_path=$( cd "$(dirname "${BASH_SOURCE[0]}")" ; pwd -P )

## hb-subset reads the --text argument in the current locale. Non-ASCII characters in
## charSetLatinExt/Cyrillic/Greek fail to decode under C/POSIX, so force a UTF-8 locale.
export LC_ALL=C.UTF-8

echo "Processing fonts from $raw_fonts_dir to $proc_fonts_dir"

## Hard-code the date to 0 to ensure that the output is deterministic.
## If this is not set, the output will be different each time the script is run even if nothing changes,
## which will massively inflate the size of the Git repository.
## See: https://reproducible-builds.org/docs/source-date-epoch/
export SOURCE_DATE_EPOCH=0

LATINBASE=$(cat "$parent_path/charSetLatinBase.txt")
LATINEXT=$(cat "$parent_path/charSetLatinExt.txt")
CYRILLIC=$(cat "$parent_path/charSetCyrillic.txt")
GREEK=$(cat "$parent_path/charSetGreek.txt")

mkdir -p "$proc_fonts_dir/latin"
mkdir -p "$proc_fonts_dir/all"

temp_dir=$(mktemp --directory)
trap 'rm -rf "$temp_dir"' EXIT

while IFS= read -r file || [[ -n "$file" ]];
do
    if [[ -f $file ]]; then
        filename=$(basename "$file")
        filename_without_extension="${filename%.*}"
        ext="${filename##*.}"

        ## Dingbats ships as a single file with no subsetting and no latin/all split.
        ## Convert the raw CFF straight to WOFF via FontForge.
        if [[ "$filename" == "Dingbats.cff" ]]; then
            echo "Processing $file (no subset)"
            fontforge -quiet -lang=ff -c 'Open($1); Generate($2)' "$file" "$proc_fonts_dir/Dingbats.woff"
            continue
        fi

        filename_proc=$filename_without_extension.woff
        file_proc_latin=$proc_fonts_dir/latin/$filename_proc
        file_proc_all=$proc_fonts_dir/all/$filename_proc
        file_temp_latin="$temp_dir/$filename_without_extension.latin.$ext"
        file_temp_all="$temp_dir/$filename_without_extension.all.$ext"

        ## If `all_fonts` option is 0, only fonts not already in the output directory are processed.
        # if [[ ! -e "$processed_fonts_dir/$filename" || "$all_fonts" = 1]]; then
        if [[ ! -e "$file_proc_latin" || "$all_fonts" = 1 ]]; then

            echo "Processing $file"

            ## hb-subset only accepts sfnt-wrapped fonts (OTF/TTF/WOFF). Bare CFF tables
            ## like the URW *.cff sources have no cmap/head/OS2 and silently produce a
            ## 12-byte empty sfnt stub. Wrap them into an OTF with FontForge first, then
            ## let the rest of the pipeline treat them like any other OTF.
            if [[ "$ext" == "cff" ]]; then
                wrapped_otf="$temp_dir/$filename_without_extension.otf"
                fontforge -quiet -lang=ff -c 'Open($1); Generate($2)' "$file" "$wrapped_otf"
                file="$wrapped_otf"
                ext="otf"
                file_temp_latin="$temp_dir/$filename_without_extension.latin.$ext"
                file_temp_all="$temp_dir/$filename_without_extension.all.$ext"
            fi

            ## Subset the raw font. hb-subset writes the same format as the input (OTF/TTF) — it
            ## cannot emit WOFF in any version we have access to, so we hand the result to FontForge
            ## below for the WOFF wrap.
            ## --layout-features-=liga,... strips ligature features so that e.g. 'fi' does not
            ## auto-include the fi ligature glyph. scribe.js renders one codepoint at a time and
            ## would otherwise end up with metrics that do not match the OCR character stream.
            ## --glyph-names preserves PostScript glyph names in TT-flavored fonts.
            HB_FLAGS="--layout-features-=liga,dlig,hlig,clig,rlig --glyph-names"
            hb-subset $HB_FLAGS --output-file="$file_temp_latin" --text="$LATINBASE$LATINEXT" "$file"
            ## "all" glyph coverage: URW Base 35 fonts (Nimbus*, C059, P052, URWGothic)
            ## keep every codepoint in the source because the source files are already
            ## small. Carlito and EBGaramond ship heavy TTFs with long tails of glyphs
            ## we don't use, so they stay restricted to Latin + Cyrillic + Greek to keep
            ## file sizes reasonable.
            case "$filename" in
                Carlito-*|EBGaramond-*)
                    all_subset_args=(--text="$LATINBASE$LATINEXT$CYRILLIC$GREEK")
                    ;;
                *)
                    all_subset_args=(--unicodes='*')
                    ;;
            esac
            hb-subset $HB_FLAGS --output-file="$file_temp_all" "${all_subset_args[@]}" "$file"

            ## FontForge picks the output format from the filename extension, so an .woff target gives WOFF1.
            fontforge -quiet -lang=ff -c 'Open($1); Generate($2)' "$file_temp_latin" "$file_proc_latin"
            fontforge -quiet -lang=ff -c 'Open($1); Generate($2)' "$file_temp_all" "$file_proc_all"

        fi
    else
        echo "File not found: $file"
    fi
done < "script/fontList.txt"

## Standardize font names to match [family]-[style].woff, as expected in the application.
mv "$proc_fonts_dir"/all/P052-Roman.woff "$proc_fonts_dir"/all/Palatino-Regular.woff
mv "$proc_fonts_dir"/all/P052-Italic.woff "$proc_fonts_dir"/all/Palatino-Italic.woff
mv "$proc_fonts_dir"/all/P052-Bold.woff "$proc_fonts_dir"/all/Palatino-Bold.woff
mv "$proc_fonts_dir"/all/P052-BoldItalic.woff "$proc_fonts_dir"/all/Palatino-BoldItalic.woff
mv "$proc_fonts_dir"/latin/P052-Roman.woff "$proc_fonts_dir"/latin/Palatino-Regular.woff
mv "$proc_fonts_dir"/latin/P052-Italic.woff "$proc_fonts_dir"/latin/Palatino-Italic.woff
mv "$proc_fonts_dir"/latin/P052-Bold.woff "$proc_fonts_dir"/latin/Palatino-Bold.woff
mv "$proc_fonts_dir"/latin/P052-BoldItalic.woff "$proc_fonts_dir"/latin/Palatino-BoldItalic.woff

mv "$proc_fonts_dir"/all/EBGaramond-Regular.woff "$proc_fonts_dir"/all/Garamond-Regular.woff
mv "$proc_fonts_dir"/all/EBGaramond-Italic.woff "$proc_fonts_dir"/all/Garamond-Italic.woff
mv "$proc_fonts_dir"/all/EBGaramond-Bold.woff "$proc_fonts_dir"/all/Garamond-Bold.woff
mv "$proc_fonts_dir"/all/EBGaramond-BoldItalic.woff "$proc_fonts_dir"/all/Garamond-BoldItalic.woff
mv "$proc_fonts_dir"/latin/EBGaramond-Regular.woff "$proc_fonts_dir"/latin/Garamond-Regular.woff
mv "$proc_fonts_dir"/latin/EBGaramond-Italic.woff "$proc_fonts_dir"/latin/Garamond-Italic.woff
mv "$proc_fonts_dir"/latin/EBGaramond-Bold.woff "$proc_fonts_dir"/latin/Garamond-Bold.woff
mv "$proc_fonts_dir"/latin/EBGaramond-BoldItalic.woff "$proc_fonts_dir"/latin/Garamond-BoldItalic.woff

mv "$proc_fonts_dir"/all/C059-Roman.woff "$proc_fonts_dir"/all/Century-Regular.woff
mv "$proc_fonts_dir"/all/C059-Italic.woff "$proc_fonts_dir"/all/Century-Italic.woff
mv "$proc_fonts_dir"/all/C059-Bold.woff "$proc_fonts_dir"/all/Century-Bold.woff
mv "$proc_fonts_dir"/all/C059-BdIta.woff "$proc_fonts_dir"/all/Century-BoldItalic.woff
mv "$proc_fonts_dir"/latin/C059-Roman.woff "$proc_fonts_dir"/latin/Century-Regular.woff
mv "$proc_fonts_dir"/latin/C059-Italic.woff "$proc_fonts_dir"/latin/Century-Italic.woff
mv "$proc_fonts_dir"/latin/C059-Bold.woff "$proc_fonts_dir"/latin/Century-Bold.woff
mv "$proc_fonts_dir"/latin/C059-BdIta.woff "$proc_fonts_dir"/latin/Century-BoldItalic.woff

mv "$proc_fonts_dir"/all/NimbusMonoPS-Regular.woff "$proc_fonts_dir"/all/NimbusMono-Regular.woff
mv "$proc_fonts_dir"/all/NimbusMonoPS-Italic.woff "$proc_fonts_dir"/all/NimbusMono-Italic.woff
mv "$proc_fonts_dir"/all/NimbusMonoPS-Bold.woff "$proc_fonts_dir"/all/NimbusMono-Bold.woff
mv "$proc_fonts_dir"/all/NimbusMonoPS-BoldItalic.woff "$proc_fonts_dir"/all/NimbusMono-BoldItalic.woff
mv "$proc_fonts_dir"/latin/NimbusMonoPS-Regular.woff "$proc_fonts_dir"/latin/NimbusMono-Regular.woff
mv "$proc_fonts_dir"/latin/NimbusMonoPS-Italic.woff "$proc_fonts_dir"/latin/NimbusMono-Italic.woff
mv "$proc_fonts_dir"/latin/NimbusMonoPS-Bold.woff "$proc_fonts_dir"/latin/NimbusMono-Bold.woff
mv "$proc_fonts_dir"/latin/NimbusMonoPS-BoldItalic.woff "$proc_fonts_dir"/latin/NimbusMono-BoldItalic.woff

mv "$proc_fonts_dir"/all/URWGothic-Book.woff "$proc_fonts_dir"/all/URWGothicBook-Regular.woff
mv "$proc_fonts_dir"/all/URWGothic-BookOblique.woff "$proc_fonts_dir"/all/URWGothicBook-Italic.woff
mv "$proc_fonts_dir"/all/URWGothic-Demi.woff "$proc_fonts_dir"/all/URWGothicBook-Bold.woff
mv "$proc_fonts_dir"/all/URWGothic-DemiOblique.woff "$proc_fonts_dir"/all/URWGothicBook-BoldItalic.woff
mv "$proc_fonts_dir"/latin/URWGothic-Book.woff "$proc_fonts_dir"/latin/URWGothicBook-Regular.woff
mv "$proc_fonts_dir"/latin/URWGothic-BookOblique.woff "$proc_fonts_dir"/latin/URWGothicBook-Italic.woff
mv "$proc_fonts_dir"/latin/URWGothic-Demi.woff "$proc_fonts_dir"/latin/URWGothicBook-Bold.woff
mv "$proc_fonts_dir"/latin/URWGothic-DemiOblique.woff "$proc_fonts_dir"/latin/URWGothicBook-BoldItalic.woff
