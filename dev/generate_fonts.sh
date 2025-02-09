raw_fonts_dir="fonts_raw"
proc_fonts_dir="fonts"
all_fonts=1
temp_dir=`mktemp --directory`
parent_path=$( cd "$(dirname "${BASH_SOURCE[0]}")" ; pwd -P )

echo "Temp dir: $temp_dir"

## Hard-code the date to 0 to ensure that the output is deterministic.
## If this is not set, the output will be different each time the script is run even if nothing changes,
## which will massively inflate the size of the Git repository.
## See: https://reproducible-builds.org/docs/source-date-epoch/
## https://github.com/fontforge/fontforge/pull/2943
export SOURCE_DATE_EPOCH=0

LATINBASE=$(cat "$parent_path/charSetLatinBase.txt")
LATINEXT=$(cat "$parent_path/charSetLatinExt.txt")
CYRILLIC=$(cat "$parent_path/charSetCyrillic.txt")
GREEK=$(cat "$parent_path/charSetGreek.txt")

mkdir -p "$proc_fonts_dir/latin"
mkdir -p "$proc_fonts_dir/all"

while IFS= read -r file || [[ -n "$file" ]];
do
    if [[ -f $file ]]; then
        filename=$(basename "$file")
        filename_without_extension="${filename%.*}"
        filename_proc=$filename_without_extension.woff
        file_proc_latin=$proc_fonts_dir/latin/$filename_proc
        file_proc_all=$proc_fonts_dir/all/$filename_proc
        file_temp1=$temp_dir/$filename_without_extension.1.otf
        file_temp2_latin=$temp_dir/$filename_without_extension.latin.otf
        file_temp2_all=$temp_dir/$filename_without_extension.all.otf

        ## If `all_fonts` option is 0, only fonts not already in the output directory are processed.
        # if [[ ! -e "$processed_fonts_dir/$filename" || "$all_fonts" = 1]]; then
        if [[ ! -e "$file_proc_latin" || "$all_fonts" = 1 ]]; then
            ## Convert to .otf
            echo "Processing $file"
            fontforge -quiet -lang=ff -c 'Open($1); Generate($2)' $file $file_temp1

            echo "Subsetting $file"

            ## Subset font to contain only desired characters
            ## The --no-layout-closure option prevents ligatures from being automatically included when all the individual characters are
            hb-subset --no-layout-closure --output-file="$file_temp2_latin" --text="$LATINBASE$LATINEXT" "$file_temp1"
            hb-subset --no-layout-closure --output-file="$file_temp2_all" --text="$LATINBASE$LATINEXT$CYRILLIC$GREEK" "$file_temp1"

            echo "Processing $file"
            ## For now, ligatures need to be included. 
            ## Ligatures are not removed when rendering to canvas, so if the font does not have them the metrics will not be correct.
            # hb-subset --output-file="$file_temp2" --text-file=dev/charSet.txt "$file_temp1"
            python dev/processFont.py "$file_temp2_latin" "$file_proc_latin"
            python dev/processFont.py "$file_temp2_all" "$file_proc_all"

        fi
    else
        echo "File not found: $file"
    fi
done < "dev/fontList.txt"

## Standardize font names to match [family]-[style].woff, as expected in the application.
mv fonts/all/P052-Roman.woff fonts/all/Palatino-Regular.woff
mv fonts/all/P052-Italic.woff fonts/all/Palatino-Italic.woff
mv fonts/all/P052-Bold.woff fonts/all/Palatino-Bold.woff
mv fonts/latin/P052-Roman.woff fonts/latin/Palatino-Regular.woff
mv fonts/latin/P052-Italic.woff fonts/latin/Palatino-Italic.woff
mv fonts/latin/P052-Bold.woff fonts/latin/Palatino-Bold.woff

mv fonts/all/EBGaramond-Regular.woff fonts/all/Garamond-Regular.woff
mv fonts/all/EBGaramond-Italic.woff fonts/all/Garamond-Italic.woff
mv fonts/all/EBGaramond-Bold.woff fonts/all/Garamond-Bold.woff
mv fonts/latin/EBGaramond-Regular.woff fonts/latin/Garamond-Regular.woff
mv fonts/latin/EBGaramond-Italic.woff fonts/latin/Garamond-Italic.woff
mv fonts/latin/EBGaramond-Bold.woff fonts/latin/Garamond-Bold.woff

mv fonts/all/C059-Roman.woff fonts/all/Century-Regular.woff
mv fonts/all/C059-Italic.woff fonts/all/Century-Italic.woff
mv fonts/all/C059-Bold.woff fonts/all/Century-Bold.woff
mv fonts/latin/C059-Roman.woff fonts/latin/Century-Regular.woff
mv fonts/latin/C059-Italic.woff fonts/latin/Century-Italic.woff
mv fonts/latin/C059-Bold.woff fonts/latin/Century-Bold.woff

mv fonts/all/NimbusMonoPS-Regular.woff fonts/all/NimbusMono-Regular.woff
mv fonts/all/NimbusMonoPS-Italic.woff fonts/all/NimbusMono-Italic.woff
mv fonts/all/NimbusMonoPS-Bold.woff fonts/all/NimbusMono-Bold.woff
mv fonts/latin/NimbusMonoPS-Regular.woff fonts/latin/NimbusMono-Regular.woff
mv fonts/latin/NimbusMonoPS-Italic.woff fonts/latin/NimbusMono-Italic.woff
mv fonts/latin/NimbusMonoPS-Bold.woff fonts/latin/NimbusMono-Bold.woff

rm -rf "$temp_dir"
