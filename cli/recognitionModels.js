import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Maps the `--model` CLI flag to the adapter package and export.
 * Packages are loaded lazily via dynamic `import()`,
 * so users who only want the built-in Tesseract engine never pull in the cloud SDKs.
 *
 * `localPath` points at the in-repo adapter source.
 * It is used by `--local-adapters` / `SCRIBE_LOCAL_ADAPTERS`
 * so contributors running from a checkout can skip `npm install @scribe.js/<adapter>`.
 */
export const recognitionModels = {
  textract: {
    package: '@scribe.js/aws-textract',
    localPath: '../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js',
    export: 'RecognitionModelTextract',
    description: 'AWS Textract',
  },
  'azure-doc-intel': {
    package: '@scribe.js/azure-doc-intel',
    localPath: '../cloud-adapters/azure-doc-intel/RecognitionModelAzureDocIntel.js',
    export: 'RecognitionModelAzureDocIntel',
    description: 'Azure Document Intelligence',
  },
  'google-doc-ai': {
    package: '@scribe.js/gcs-doc-ai',
    localPath: '../cloud-adapters/gcs-doc-ai/RecognitionModelGoogleDocAI.js',
    export: 'RecognitionModelGoogleDocAI',
    description: 'Google Document AI',
  },
  'google-vision': {
    package: '@scribe.js/gcs-vision',
    localPath: '../cloud-adapters/gcs-vision/RecognitionModelGoogleVision.js',
    export: 'RecognitionModelGoogleVision',
    description: 'Google Cloud Vision',
  },
};

/**
 * Resolve a `--model <name>` flag to the adapter class.
 * Throws an `Error` whose message is safe to print directly to stderr
 * when the model name is unknown or the adapter cannot be loaded.
 *
 * Tests may inject a stub by setting `SCRIBE_TEST_MODEL_OVERRIDE`
 * to a JSON object mapping model name to `{ modulePath, export }`.
 * This is the only place that env var is read.
 *
 * @param {string} name
 * @param {Object} [opts]
 * @param {boolean} [opts.localAdapters] - Load from the in-repo `cloud-adapters/` tree
 *   instead of the published npm package.
 *   Defaults to the truthiness of `SCRIBE_LOCAL_ADAPTERS`.
 * @returns {Promise<any>} The adapter class.
 */
export async function loadRecognitionModel(name, opts = {}) {
  const overrideRaw = process.env.SCRIBE_TEST_MODEL_OVERRIDE;
  if (overrideRaw) {
    const overrides = JSON.parse(overrideRaw);
    const override = overrides[name];
    if (override) {
      const mod = await import(override.modulePath);
      const cls = mod[override.export];
      if (!cls) throw new Error(`Override module ${override.modulePath} does not export ${override.export}.`);
      return cls;
    }
  }

  const entry = recognitionModels[name];
  if (!entry) {
    const supported = Object.keys(recognitionModels).join(', ');
    throw new Error(`Unknown model: '${name}'. Supported models: ${supported}.`);
  }

  const localAdapters = opts.localAdapters ?? !!process.env.SCRIBE_LOCAL_ADAPTERS;

  if (localAdapters) return loadLocalAdapter(name, entry);

  let mod;
  try {
    mod = await import(entry.package);
  } catch (err) {
    const missing = err && err.code === 'ERR_MODULE_NOT_FOUND'
      && (typeof err.message !== 'string' || err.message.includes(entry.package));
    if (missing) {
      throw new Error(`Model '${name}' requires '${entry.package}'. Install it with: npm install ${entry.package}`);
    }
    throw err;
  }

  const cls = mod[entry.export];
  if (!cls) throw new Error(`Package '${entry.package}' does not export ${entry.export}.`);
  return cls;
}

async function loadLocalAdapter(name, entry) {
  const localUrl = new URL(entry.localPath, import.meta.url);
  const localFs = fileURLToPath(localUrl);
  if (!fs.existsSync(localFs)) {
    throw new Error(`Local adapter not found at ${localFs}. --local-adapters / SCRIBE_LOCAL_ADAPTERS requires a checkout of the scribe.js repo; published builds do not ship cloud-adapters/.`);
  }
  const localDir = fileURLToPath(new URL('.', localUrl));
  let mod;
  try {
    mod = await import(localUrl.href);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      const firstLine = String(err.message).split('\n')[0];
      throw new Error(`Local adapter '${name}' failed to load: ${firstLine}. Install its dependencies with: cd ${localDir} && npm install`);
    }
    throw err;
  }
  const cls = mod[entry.export];
  if (!cls) throw new Error(`Local adapter at ${localFs} does not export ${entry.export}.`);
  return cls;
}

function coerceScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function coerceValue(raw) {
  if (raw.includes(',')) return raw.split(',').map((s) => coerceScalar(s.trim()));
  return coerceScalar(raw);
}

/**
 * Commander accumulator for `-O, --model-option <key=value>`.
 *
 * @param {string} value
 * @param {Object} accum
 * @returns {Object}
 */
export function parseModelOption(value, accum) {
  const eq = value.indexOf('=');
  if (eq === -1) throw new Error(`--model-option expects key=value, got '${value}'.`);
  const key = value.slice(0, eq).trim();
  const raw = value.slice(eq + 1);
  if (!key) throw new Error(`--model-option key is empty in '${value}'.`);
  accum[key] = coerceValue(raw);
  return accum;
}
