## Verify that every subset font produced by generate_fonts.sh actually contains
## the glyphs we asked for. hb-subset does not warn if a requested codepoint is
## missing from the source, so this is the backstop that catches that.
## Run from the parent of script/ (same working dir as generate_fonts.sh).

for proc_fonts_dir in ../../fonts/latin ../../fonts/all; do
    for file in "$proc_fonts_dir"/*.woff; do
        echo "$file"
        if [[ -f $file ]]; then
            python script/checkChars.py "$file" script/charSetLatinBase.txt
            python script/checkChars.py "$file" script/charSetLatinExt.txt
            if [[ "$proc_fonts_dir" == "../../fonts/all" ]]; then
                python script/checkChars.py "$file" script/charSetCyrillic.txt
                python script/checkChars.py "$file" script/charSetGreek.txt
            fi
        fi
    done
done

## Missing characters reported for signature fonts are gaps in the source fonts rather than build failures.
for file in ../../fonts/signature/*.woff2; do
    echo "$file"
    if [[ -f $file ]]; then
        python script/checkChars.py "$file" script/charSetLatinBase.txt
        python script/checkChars.py "$file" script/charSetLatinExt.txt
    fi
done
