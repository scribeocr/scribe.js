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
    };

    // Strings representing supported sources of text.
    // `stext` indicates the text was extracted directly from a PDF using mupdf.
    type TextSource = null | 'tesseract' | 'textract' | 'google_vision' | 'abbyy' | 'stext' | 'hocr' | 'text';

    type FontState = {
        enableOpt: boolean;
        forceOpt: boolean;
        enableCleanToNimbusMono: boolean;
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

    type opentypeFont = import("../lib/opentype.module.js").Font;
    type opentypeGlyph = import("../lib/opentype.module.js").Glyph;
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

    type ProgressMessage = ProgressMessageConvert | ProgressMessageGeneral;

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

    type FileNode = import("./import/nodeAdapter.js").FileNode;

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

}

export { };

