declare global {

    type Style = {
        font: ?string;
        size: ?number;
        bold: boolean;
        italic: boolean;
        underline: boolean;
        smallCaps: boolean;
        sup: boolean;
        dropcap: boolean;
        color: string;
        opacity: number;
        /** Target URL when the word is covered by a PDF /Link annotation; absent otherwise. */
        link?: string;
    };

    /**
     * A mid-word style change, e.g. an italic title's roman trailing comma.
     * A new style begins at text index `i` and runs to the next entry or the end of the word.
     * Fields omitted from `style` inherit the word's own style.
     */
    type StyleRun = {
        i: number;
        style: Partial<Style>;
    };

    // The kind of file or data a page's text layer was imported from.
    // `stext` is the legacy spelling of `pdf`, remapped when older files are restored.
    type TextSource = null | 'pdf' | 'tesseract' | 'textract' | 'google_vision' | 'google_doc_ai' | 'abbyy' | 'alto' | 'stext' | 'hocr' | 'text' | 'azure_doc_intel' | 'docx';

    /**
     * Signals read from a tagged PDF's marked content and structure tree for one word.
     * Produced while parsing and consumed by the layout pass of that same import.
     */
    type PdfWordSignal = {
        artifact: boolean;
        mcid: number | null;
        /** Object number of the structure element owning this word, once inline tags have rolled up to their block ancestor. */
        structElemId: number | null;
        structElemTag: string | null;
    };

    type FontState = {
        enableOpt: boolean;
        forceOpt: boolean;
        defaultFontName: string;
        serifDefaultName: string;
        sansDefaultName: string;
        glyphSet: null | 'latin' | 'all';
        charMetrics: { [key: string]: CharMetricsFamily };
    }

    type ScribeSaveData = {
        ocr: OcrPage[];
        fontState: FontState;
        layoutRegions: LayoutPage[];
        layoutDataTables: LayoutDataTablePage[];
        annotations: Annotation[][];
        pageRotations?: number[];
        session?: ScribeSessionData;
    }

    type StyleLookup = ('normal' | 'bold' | 'italic' | 'boldItalic');

    // OCR objects
    type OcrPage = import("./objects/ocrObjects.js").OcrPage;
    type OcrLine = import("./objects/ocrObjects.js").OcrLine;
    type OcrWord = import("./objects/ocrObjects.js").OcrWord;
    type OcrChar = import("./objects/ocrObjects.js").OcrChar;

    // Font objects
    type CharMetricsFont = import("./objects/charMetricsObjects.js").CharMetricsFont;
    type CharMetricsRawFamily = import("./objects/charMetricsObjects.js").CharMetricsRawFamily;
    type CharMetricsFamily = import("./objects/charMetricsObjects.js").CharMetricsFamily;
    type CharMetricsRawFont = import("./objects/charMetricsObjects.js").CharMetricsRawFont;
    type FontContainerFont = import("./containers/fontContainer.js").FontContainerFont;

    type FontContainerFamilyBuiltIn = {
        normal: FontContainerFont;
        italic: FontContainerFont;
        bold: FontContainerFont;
        boldItalic: FontContainerFont;
    };

    type FontContainerFamilyUpload = {
        normal: FontContainerFont | null;
        italic: FontContainerFont | null;
        bold: FontContainerFont | null;
        boldItalic: FontContainerFont | null;
    };

    type FontContainerFamily = FontContainerFamilyBuiltIn | FontContainerFamilyUpload;

    type FontContainer = {
        Carlito: FontContainerFamilyBuiltIn;
        Century: FontContainerFamilyBuiltIn;
        Garamond: FontContainerFamilyBuiltIn;
        Palatino: FontContainerFamilyBuiltIn;
        NimbusRoman: FontContainerFamilyBuiltIn;
        NimbusSans: FontContainerFamilyBuiltIn;
        NimbusMono: FontContainerFamilyBuiltIn;
        [key: string]: FontContainerFamily;
    };

    type fontSrcBuiltIn = {
        normal: ArrayBuffer;
        italic: ArrayBuffer;
        bold: ArrayBuffer;
        boldItalic: ArrayBuffer;
    };

    type fontSrcUpload = {
        normal: ArrayBuffer | null;
        italic: ArrayBuffer | null;
        bold: ArrayBuffer | null;
        boldItalic: ArrayBuffer | null;
    };

    type opentypeFont = import("./font-parser/src/index.js").Font;
    type opentypeGlyph = import("./font-parser/src/index.js").Glyph;
    type GeneralScheduler = import("./generalWorkerMain.js").GeneralScheduler;

    // Image objects
    type ImageWrapper = import("./objects/imageObjects.js").ImageWrapper;

    /**
     * Information from the IHDR chunk of a PNG file.
     */
    type PngIHDRInfo = {
        /** Image width in pixels. */
        width: number;
        /** Image height in pixels. */
        height: number;
        /** Bits per sample or per palette index. */
        bitDepth: number;
        /** Color type (e.g., grayscale, RGB, palette). */
        colorType: number;
        /** Compression method (always 0 for PNG). */
        compressionMethod: number;
        /** Filter method (always 0 for PNG). */
        filterMethod: number;
        /** Interlace method (0 for none, 1 for Adam7). */
        interlaceMethod: number;
    };

    type dims = {
        height: number;
        width: number;
    };

    type bbox = {
        left: number;
        right: number;
        top: number;
        bottom: number;
    };

    type PageMetrics = import("./objects/pageMetricsObjects.js").PageMetrics;

    type EvalMetrics = {
        total: number;
        correct: number;
        incorrect: number;
        missed: number;
        extra: number;
        correctLowConf: number;
        incorrectHighConf: number;
    };
    /**
     * Represents a comparison debug object with image data and error metrics.
     * Raw errors are calculated purely based on visual overlap. Words where most pixels overlap with the underlying image will have low raw error.
     * Adjusted errors are calculated by applying ad-hoc adjustments to raw errors. The intent of these adjustments is to penalize patterns of letters
     * that are visually similar to other letters but unlikely to occur in correct recognition results.
     */
    type CompDebugBrowser = {
        context: 'browser';
        imageRaw: Blob; // The raw image blob.
        imageA: Blob; // The first image blob for comparison.
        imageB: Blob; // The second image blob for comparison.
        dims: dims; // Dimensions object specifying size or other dimensional data.
        errorRawA: number; // Raw error of "A" words, calculated purely based on visual overlap.
        errorRawB: number; // Raw error of "B" words, similar to errorRawA.
        errorAdjA: number | null; // Adjusted error of "A" words. Null until calculated.
        errorAdjB: number | null; // Adjusted error of "B" words. Null until calculated.
    };

    /**
     * Represents a comparison debug object with image data and error metrics.
     * Raw errors are calculated purely based on visual overlap. Words where most pixels overlap with the underlying image will have low raw error.
     * Adjusted errors are calculated by applying ad-hoc adjustments to raw errors. The intent of these adjustments is to penalize patterns of letters
     * that are visually similar to other letters but unlikely to occur in correct recognition results.
     */
    type CompDebugNode = {
        context: 'node';
        imageRaw: import('canvas').Image; // The raw image.
        imageA: import('canvas').Image; // The first image for comparison.
        imageB: import('canvas').Image; // The second image for comparison.
        dims: dims; // Dimensions object specifying size or other dimensional data.
        errorRawA: number; // Raw error of "A" words, calculated purely based on visual overlap.
        errorRawB: number; // Raw error of "B" words, similar to errorRawA.
        errorAdjA: number | null; // Adjusted error of "A" words. Null until calculated.
        errorAdjB: number | null; // Adjusted error of "B" words. Null until calculated.
    };

    type ProgressMessage = ProgressMessageConvert | ProgressMessageGeneral | ProgressMessageRecognize;

    type ProgressMessageGeneral = {
        type: 'export' | 'importImage' | 'importPDF' | 'render';
        n: number;
        info: {};
    }

    type ProgressMessageConvert = {
        type: 'convert';
        n: number;
        info: {
            engineName: string;
        };
    }

    type ProgressMessageRecognize = {
        type: 'recognize';
        n?: number;
        info?: {
            status?: string;
            engineName?: string;
            elapsedMs?: number;
            responsesReceived?: number;
            timestamp?: number;
            /** Engine-defined stage name, on `status: 'progress'` messages from document-mode models. */
            stage?: string;
            /** Document-scoped completion percentage (0-100), on `status: 'progress'` messages. */
            pct?: number;
        };
    }

    type FileNode = import("./import/nodeAdapter.js").FileNode;

    /** One reply in a comment thread. Round-trips as a PDF /Text annotation with /IRT. */
    type AnnotationReply = {
        text: string;
        /** Reply author (PDF /T); omitted when unauthored. */
        author?: string;
        /** Reply creation time, UTC ISO-8601. */
        createdAt?: string;
    };

    /**
     * A text-markup annotation (PDF /Highlight, /Underline, or /StrikeOut) anchored to a text range.
     * A missing `type` is a legacy highlight; `'underline'`/`'strikeout'` are always explicit.
     */
    type AnnotationHighlight = {
        type?: 'highlight' | 'underline' | 'strikeout';
        bbox: bbox;
        color: string;
        opacity: number;
        groupId: string;
        comment?: string;
        author?: string;
        createdAt?: string;
        /** Reply thread under the comment, oldest first. */
        replies?: AnnotationReply[];
        quads?: bbox[];
    };

    type AnnotationFreeText = {
        type: 'freetext';
        /** Annotation rectangle in page coordinates (top-left origin, same frame as OCR words). */
        bbox: bbox;
        contents: string;
        /** Text size in the same coordinate frame as bbox (converted to PDF points at write time). */
        fontSize: number;
        /** Text color, '#rrggbb'. */
        textColor: string;
        /** Background color, '#rrggbb'; omitted = transparent. */
        fillColor?: string;
        opacity: number;
        /** Reply thread on the annotation, oldest first. */
        replies?: AnnotationReply[];
    };

    type AnnotationShapeStyle = {
        /** Stroke/border color, '#rrggbb'. Default '#ff0000'. */
        borderColor?: string;
        /** Interior fill, '#rrggbb'; omitted = outline only. */
        fillColor?: string;
        /** Opacity 0..1 applied to stroke and fill. Default 1. */
        opacity?: number;
        /** Border width in page units. Default 1. */
        borderWidth?: number;
        comment?: string;
        /** Comment author (PDF /T); omitted when unauthored. */
        author?: string;
        /** Comment creation time*/
        createdAt?: string;
        /** Reply thread under the comment, oldest first. */
        replies?: AnnotationReply[];
    };

    /** Geometry below is in page coordinates (top-left origin, same frame as OCR words). */
    type AnnotationSquare = AnnotationShapeStyle & { type: 'square'; bbox: bbox; };
    type AnnotationCircle = AnnotationShapeStyle & { type: 'circle'; bbox: bbox; };
    type AnnotationLine = AnnotationShapeStyle & { type: 'line'; points: [number, number, number, number]; };
    type AnnotationPolygon = AnnotationShapeStyle & { type: 'polygon' | 'polyline'; vertices: number[]; };
    type AnnotationShape = AnnotationSquare | AnnotationCircle | AnnotationLine | AnnotationPolygon;

    /** A PDF /Text annotation: a freestanding comment marker, not anchored to a text range. */
    type AnnotationText = {
        type: 'text';
        /** Small icon rect at the drop point, pixel space (top-left origin, same frame as OCR words). */
        bbox: bbox;
        comment: string;
        /** Icon color, '#rrggbb' (PDF /C); omitted = viewer default. */
        color?: string;
        /** Comment author (PDF /T). */
        author?: string;
        /** Comment creation time. */
        createdAt?: string;
        /** Reply thread under the comment, oldest first. */
        replies?: AnnotationReply[];
        /** Whether the note popup opens by default. */
        open?: boolean;
    };

    /**
     * A redaction mark: an area slated for destructive removal at export.
     * `.scribe` saves keep the mark unapplied; every other export removes the marked content.
     */
    type AnnotationRedact = {
        /** Required because writers read a missing `type` as a legacy highlight. */
        type: 'redact';
        /** Region to erase, page coordinates (top-left origin, same frame as OCR words). */
        bbox: bbox;
        /** Ties together the rects of one mark; a multi-line selection makes several, a box mark one. */
        groupId: string;
    };

    /**
     * A clickable link region.
     * Exactly one of `dest` / `uri` is set.
     */
    type AnnotationLink = {
        type: 'link';
        /** Clickable region, page coordinates (top-left origin, same frame as OCR words). */
        bbox: bbox;
        /** Internal page target. */
        dest?: OutlineDest;
        /** External URL. */
        uri?: string;
    };

    /**
     * An AcroForm field, lifted from a source-PDF Widget annotation.
     * The filled value of a text/choice field also appears in the page's OCR text as ordinary words.
     */
    type AnnotationField = {
        type: 'field';
        fieldType: 'text' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'button';
        /**
         * Fully-qualified field name.
         * Each level's /T, root-to-leaf, joined with '.'.
         */
        name: string;
        /** Widget rect, page coordinates (top-left origin, same frame as OCR words). */
        bbox: bbox;
        /**
         * Current field value.
         * A multi-select choice field's selected options are joined into one '; '-separated string.
         */
        value: string | null;
        /** Source widget object number in the originating PDF. */
        srcRef?: number;
        readOnly?: boolean;
        /** Field flag bit 2. */
        required?: boolean;
        /** Text field flag bit 13. */
        multiline?: boolean;
        /** Text field flag bit 25. */
        comb?: boolean;
        /** Cell count for comb fields. */
        maxLen?: number;
        signed?: boolean;
        /**
         * Widget carries the hidden or no-view annotation flag.
         * Its value is not lifted into the page's OCR text.
         */
        hidden?: boolean;
        /**
         * Text alignment from /Q.
         * 1 is centered, 2 is right-aligned, absent is left.
         */
        quadding?: number;
        /** /DA default-appearance string. */
        da?: string;
        /** Checkbox/radio on-state name. */
        onState?: string;
        /**
         * Choice-field option list from /Opt.
         * Export/display pairs contribute only the display string, so `value` may be an export value missing from this list.
         */
        options?: string[];
    };

    /**
     * A drawn fill & sign item.
     * PDF export flattens it into page content.
     */
    type AnnotationInk = {
        type: 'ink';
        /** Stroke polylines in page coordinates (top-left origin). */
        strokes: Array<Array<[number, number]>>;
        width: number;
        /** Stroke color, '#RRGGBB'. */
        color?: string;
        /** Extent of the strokes padded by half the stroke width. */
        bbox: bbox;
    };

    /**
     * A placed image fill & sign item, such as an uploaded or typed signature.
     * PDF export flattens it into page content.
     */
    type AnnotationStamp = {
        type: 'stamp';
        bbox: bbox;
        /** PNG or JPEG data URL. */
        imageData: string;
    };

    type Annotation = AnnotationHighlight | AnnotationFreeText | AnnotationShape | AnnotationText | AnnotationRedact | AnnotationLink | AnnotationField | AnnotationInk | AnnotationStamp;

    /**
     * One removed word's glyph identities.
     * The arrays are index-aligned per glyph, with positions in the page-pixel frame.
     */
    type TextEditGlyphWord = {
        /** Per-glyph unicode strings (a ligature glyph is one entry). */
        chars: string[];
        /** Per-glyph pen-origin x. */
        x: number[];
        /** Per-glyph pen-origin (baseline) y. */
        y: number[];
        fontObjNum?: number;
    };

    /**
     * Visible source-PDF text slated for removal.
     * Vector paths, images, and annotations under the rects are untouched.
     */
    type TextEditDelete = {
        type: 'deleteText';
        id: string;
        /** Regions whose glyphs are removed, page coordinates (top-left origin, same frame as OCR words). */
        rects: bbox[];
        /**
         * When present, a rect removes only the glyphs matching these identities, so visually-overlapping other text survives.
         * Records without identities (legacy sessions) remove every glyph under their rects.
         */
        glyphs?: TextEditGlyphWord[];
        /** Ties together the records of one user action. */
        groupId?: string;
    };

    /**
     * One same-font stretch of replacement glyphs, drawn from a fixed baseline origin.
     * Geometry is in the page-pixel frame.
     * Consumers draw the glyphs verbatim, so the raster, editor, and export cannot disagree.
     */
    type TextEditRun = {
        x: number;
        y: number;
        /** Line orientation (quarter-turns), same convention as OCR lines. */
        orientation: number;
        sizePx: number;
        /** Fill color, `#rrggbb`. */
        color: string;
        /** Text render mode of the replaced faux-bold text: 1 = stroke only, 2 = fill + stroke. Absent for plain filled text. */
        renderMode?: number;
        /** Stroke pen width in page pixels, present with `renderMode`. */
        strokeWidthPx?: number;
        /** Stroke color, `#rrggbb`; black when absent. */
        strokeColor?: string;
        /** Shear ratio of faux-oblique text (x offset per unit above the baseline). Absent for upright text. */
        skew?: number;
        /**
         * Horizontal glyph scale of a fitted substitute face.
         * The run's `advEm` values already include it.
         */
        stretch?: number;
        font: { kind: 'orig', fontObjNum: number } | { kind: 'bundled', family: string, styleKey: string };
        /**
         * Pre-resolved glyphs.
         * Canvas drawing uses `cp`.
         * The PDF export writes `gid` into Identity-H TJ runs.
         * A tofu entry draws the missing-glyph box instead.
         */
        glyphs: Array<{ cp?: number, gid?: number, advEm: number, tofu?: boolean }>;
    };

    /**
     * Visible source-PDF text replaced by the record's runs, with the originals suppressed exactly like a deletion.
     * On export the runs are spliced at the removed glyphs' stream position, preserving reading order.
     */
    type TextEditReplace = {
        type: 'replaceText';
        id: string;
        /** Page coordinates (top-left origin). */
        rects: bbox[];
        runs: TextEditRun[];
        /** The replaced originals' glyph identities, gated at the strike exactly as on a deleteText record. */
        glyphs?: TextEditGlyphWord[];
        /** Ids of the live OCR words this record draws, so a later edit of those words folds this record. */
        wordIds?: string[];
        groupId?: string;
    };

    type TextEdit = TextEditDelete | TextEditReplace;

    /**
     * Parse-derived metadata for one visibly-drawn native word.
     * Array fields are index-aligned with the word's `chars`.
     */
    type NativeTextWord = {
        fontObjNum?: number;
        /** Unrounded baseline y in page pixels. */
        baselineY: number;
        /** Per-glyph pen-origin x, unrounded. */
        penX?: number[];
        /** Per-glyph shear ratio of faux-oblique text, 0 for unsheared glyphs. */
        skew?: number[];
        /** Per-glyph horizontal stretch ratio, 0 for unstretched glyphs. */
        stretch?: number[];
        /** Text render mode of faux-bold text: 1 = stroke only, 2 = fill + stroke. Absent for plain filled text. */
        renderMode?: number;
        /** Stroke pen width in page pixels, present with `renderMode`. */
        strokeWidthPx?: number;
        /** Stroke color, `#rrggbb`; black when absent. */
        strokeColor?: string;
    };

    /**
     * Data inside a `.scribe` file that only this application consumes.
     * Written only when the export opts in with `scribeSession`, so standard-format consumers never see it.
     */
    type ScribeSessionData = {
        v: number;
        textEdits?: TextEdit[][];
        nativeText?: Array<Record<string, NativeTextWord>>;
        /** `[page, index]` positions in `doc.annotations.pages` of the `freetext` rows that are fill & sign typed text. */
        fillText?: Array<[number, number]>;
    };

    type OutlineDest = import("./objects/outlineObjects.js").OutlineDest;

    // Layout objects
    type LayoutPage = import("./objects/layoutObjects.js").LayoutPage;
    type LayoutDataTablePage = import("./objects/layoutObjects.js").LayoutDataTablePage;
    type LayoutDataTable = import("./objects/layoutObjects.js").LayoutDataTable;
    type LayoutDataColumn = import("./objects/layoutObjects.js").LayoutDataColumn;
    type LayoutRegion = import("./objects/layoutObjects.js").LayoutRegion;

    interface Point {
        x: number;
        y: number;
    }

    interface Polygon {
        br: Point;
        bl: Point;
        tr: Point;
        tl: Point;
    }

    interface TextractBoundingBox {
        Width: number;
        Height: number;
        Left: number;
        Top: number;
    }

    interface TextractPoint {
        X: number;
        Y: number;
    }

    type PdfFontInfo = {
        type: number;
        index: number;
        name: string;
        objN: number;
        opentype: opentypeFont;
        /**
         * Width-scaled variants of this font for words that would otherwise split when a viewer extracts text.
         * These differ only in declared advance widths, sharing the base `opentype` object by reference and carrying a `widthScale` (see below).
         */
        widthVariants?: Array<{ scale: number; info: PdfFontInfo }>;
        /**
         * Advance-width multiplier for a width-scaled variant. Absent (treated as 1) on base fonts.
         * Applied when generating the variant's `/W` array and at the export-font advance reads in `writePdfText`.
         */
        widthScale?: number;
        /**
         * For a width-scaled variant, the object numbers of the base font's shared FontDescriptor and ToUnicode CMap.
         * The variant references these instead of re-embedding the font program.
         * Their presence marks "variant mode" in `createEmbeddedFontType0`.
         */
        baseDescriptorObjN?: number;
        baseToUnicodeObjN?: number;
        /**
         * Per-GID unicode override for the embedded font's ToUnicode CMap.
         * For example, ligature or Type3-replacement glyphs whose code does not map to a single source character.
         */
        toUnicodeOverride?: Map<number, string>;
    };

    type PdfFontFamily = {
        normal?: PdfFontInfo;
        italic?: PdfFontInfo;
        bold?: PdfFontInfo;
        boldItalic?: PdfFontInfo;
        [style: string]: PdfFontInfo | undefined;
    };

    interface TextractGeometry {
        BoundingBox: TextractBoundingBox;
        Polygon: TextractPoint[];
        RotationAngle: number;
    }

    interface Relationship {
        Type: string;
        Ids: string[];
    }

    interface TextractBlock {
        BlockType: "WORD" | "LINE" | "PAGE" | "KEY_VALUE_SET" | "CELL" | "MERGED_CELL" | "SELECTION_ELEMENT" | "TABLE";
        Confidence: number;
        Text: string;
        TextType: "PRINTED" | "HANDWRITING";
        Geometry: TextractGeometry;
        Id: string;
        Page?: number;
        Relationships?: Relationship[];
    }

    // Google Vision types
    interface GoogleVisionVertex {
        x: number;
        y: number;
    }

    interface GoogleVisionBoundingPoly {
        vertices: GoogleVisionVertex[];
        normalizedVertices: GoogleVisionVertex[];
    }

    interface GoogleVisionDetectedLanguage {
        languageCode: string;
        confidence: number;
    }

    interface GoogleVisionDetectedBreak {
        type: 'UNKNOWN' | 'SPACE' | 'SURE_SPACE' | 'EOL_SURE_SPACE' | 'HYPHEN' | 'LINE_BREAK';
        isPrefix: boolean;
    }

    interface GoogleVisionTextProperty {
        detectedLanguages: GoogleVisionDetectedLanguage[];
        detectedBreak?: GoogleVisionDetectedBreak;
    }

    interface GoogleVisionSymbol {
        property?: GoogleVisionTextProperty;
        boundingBox: GoogleVisionBoundingPoly;
        text: string;
        confidence: number;
    }

    interface GoogleVisionWord {
        property?: GoogleVisionTextProperty;
        boundingBox: GoogleVisionBoundingPoly;
        symbols: GoogleVisionSymbol[];
        confidence: number;
    }

    interface GoogleVisionParagraph {
        property?: GoogleVisionTextProperty;
        boundingBox: GoogleVisionBoundingPoly;
        words: GoogleVisionWord[];
        confidence: number;
    }

    interface GoogleVisionBlock {
        property?: GoogleVisionTextProperty;
        boundingBox: GoogleVisionBoundingPoly;
        paragraphs: GoogleVisionParagraph[];
        blockType: 'UNKNOWN' | 'TEXT' | 'TABLE' | 'PICTURE' | 'RULER' | 'BARCODE';
        confidence: number;
    }

    interface GoogleVisionPage {
        property?: GoogleVisionTextProperty;
        width: number;
        height: number;
        blocks: GoogleVisionBlock[];
        confidence: number;
    }

    interface GoogleVisionFullTextAnnotation {
        pages: GoogleVisionPage[];
        text: string;
    }

    // Recognition model types (for custom/external recognition models)
    type RecognitionOutputFormat = 'textract' | 'google_vision' | 'google_doc_ai' | 'azure_doc_intel' | 'hocr' | 'abbyy' | 'alto' | 'stext' | 'text';

    type RecognitionResult = {
        success: boolean;
        rawData?: string;
        format: RecognitionOutputFormat | string;
        error?: Error;
    };

    interface RecognitionModelConfig {
        name: string;
        outputFormat: RecognitionOutputFormat | null;
        rateLimit?: { tps: number } | { rpm: number };
        /** Recognize the whole document in one `recognizeDocument` call instead of per-image dispatch. */
        documentMode?: boolean;
        /** The model honors the `pages` input and recognizes only those pages. */
        documentModePageSelection?: boolean;
    }

    /**
     * One entry in a document-mode result stream.
     * Progress entries omit `pageNum` for document-level stages.
     */
    type RecognitionDocumentEntry = {
        pageNum: number;
        rawData?: string;
        error?: Error;
    } | {
        pageNum?: number;
        progress: { stage?: string; pct?: number };
    };

    interface RecognitionModel {
        config: RecognitionModelConfig;
        recognizeImage(imageData: Uint8Array | ArrayBuffer, options?: any): Promise<RecognitionResult>;
        /**
         * Called instead of `recognizeImage` when `config.documentMode` is set.
         * `pdfBytes` is null for image-mode documents.
         * `pages` is set only for `documentModePageSelection` models on a partial selection.
         */
        recognizeDocument?(
            input: { pdfBytes: Uint8Array | null; pageCount: number; pageDims: dims[]; pages?: number[] },
            options?: any,
        ): AsyncIterable<RecognitionDocumentEntry> | Promise<AsyncIterable<RecognitionDocumentEntry>>;
        convertPage?(rawData: string, n: number): Promise<{
            pageObj: OcrPage;
            dataTables: LayoutDataTablePage;
            warn: object;
            langSet: Set<string>;
            fontSet: Set<string>;
        }>;
        isThrottlingError?(error: Error): boolean;
    }

    // Azure Document Intelligence types
    interface AzureDocIntelSpan {
        offset: number;
        length: number;
    }

    interface AzureDocIntelWord {
        content: string;
        polygon: number[];
        span: AzureDocIntelSpan;
        confidence: number;
    }

    interface AzureDocIntelLine {
        content: string;
        polygon: number[];
        spans: AzureDocIntelSpan[];
    }

    interface AzureDocIntelStyle {
        isHandwritten?: boolean;
        spans: AzureDocIntelSpan[];
        confidence: number;
    }

    interface AzureDocIntelPage {
        pageNumber: number;
        angle: number;
        width: number;
        height: number;
        unit: 'pixel' | 'inch';
        words: AzureDocIntelWord[];
        lines: AzureDocIntelLine[];
        spans: AzureDocIntelSpan[];
    }

    interface AzureDocIntelAnalyzeResult {
        apiVersion: string;
        modelId: string;
        content: string;
        pages: AzureDocIntelPage[];
        styles: AzureDocIntelStyle[];
    }

    interface AzureDocIntelResponse {
        status: 'succeeded' | 'failed' | 'running';
        createdDateTime: string;
        lastUpdatedDateTime: string;
        analyzeResult: AzureDocIntelAnalyzeResult;
    }

    // Tesseract types
    type TessOutputFormats = {
        text: boolean;
        blocks: boolean;
        layoutBlocks: boolean;
        hocr: boolean;
        tsv: boolean;
        box: boolean;
        unlv: boolean;
        osd: boolean;
        imageColor: boolean;
        imageGrey: boolean;
        imageBinary: boolean;
        debug: boolean;
    };

    type TessRecognizeOptions = {
        rectangle: TessRectangle;
        rotateAuto: boolean;
        rotateRadians: number;
    };

    type TessRecognizeResult = {
        jobId: string;
        data: TessPage;
    };

    type TessRectangle = {
        left: number;
        top: number;
        width: number;
        height: number;
    };

    type TessImageLike = string | Blob;

    type TessBaseline = {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        has_baseline: boolean;
    };

    type TessRowAttributes = {
        ascenders: number;
        descenders: number;
        rowHeight: number;
    };

    type TessBbox = {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };

    type TessChoice = {
        text: string;
        confidence: number;
    };

    type TessSymbol = {
        choices: TessChoice[];
        image: any;
        text: string;
        confidence: number;
        baseline: TessBaseline;
        bbox: TessBbox;
        is_superscript: boolean;
        is_subscript: boolean;
        is_dropcap: boolean;
        word: TessWord;
        line: TessLine;
        paragraph: TessParagraph;
        block: TessBlock;
        page: TessPage;
    };

    type TessWord = {
        symbols: TessSymbol[];
        choices: TessChoice[];
        text: string;
        confidence: number;
        baseline: TessBaseline;
        bbox: TessBbox;
        is_numeric: boolean;
        in_dictionary: boolean;
        direction: string;
        language: string;
        is_bold: boolean;
        is_italic: boolean;
        is_underlined: boolean;
        is_monospace: boolean;
        is_serif: boolean;
        is_smallcaps: boolean;
        font_size: number;
        font_id: number;
        font_name: string;
        line: TessLine;
        paragraph: TessParagraph;
        block: TessBlock;
        page: TessPage;
    };

    type TessLine = {
        words: TessWord[];
        text: string;
        confidence: number;
        baseline: TessBaseline;
        rowAttributes: TessRowAttributes;
        bbox: TessBbox;
        paragraph: TessParagraph;
        block: TessBlock;
        page: TessPage;
        symbols: TessSymbol[];
    };

    type TessParagraph = {
        lines: TessLine[];
        text: string;
        confidence: number;
        baseline: TessBaseline;
        bbox: TessBbox;
        is_ltr: boolean;
        block: TessBlock;
        page: TessPage;
        words: TessWord[];
        symbols: TessSymbol[];
    };

    type TessBlock = {
        paragraphs: TessParagraph[];
        text: string;
        confidence: number;
        baseline: TessBaseline;
        bbox: TessBbox;
        blocktype: string;
        polygon: any;
        page: TessPage;
        lines: TessLine[];
        words: TessWord[];
        symbols: TessSymbol[];
    };

    type TessPage = {
        blocks: TessBlock[] | null;
        confidence: number;
        lines: TessLine[];
        oem: string;
        osd: string;
        paragraphs: TessParagraph[];
        psm: string;
        symbols: TessSymbol[];
        text: string;
        version: string;
        words: TessWord[];
        hocr: string | null;
        tsv: string | null;
        box: string | null;
        unlv: string | null;
        sd: string | null;
        imageColor: string | null;
        imageGrey: string | null;
        imageBinary: string | null;
        rotateRadians: number | null;
        debug: string | null;
        debugVis: string | null;
    };

}

export { };

