import { ScrollView } from '../scrollview/ScrollView.js';
import { colorsMapping } from '../src/constants.js';

const mainColElem = /** @type {HTMLDivElement} */ (document.getElementById('mainCol'));
const infoColElem = /** @type {HTMLDivElement} */ (document.getElementById('infoCol'));
const sidebarAreaElem = /** @type {HTMLDivElement} */ (document.getElementById('sidebarArea'));
const sidebarScrollAreaElem = /** @type {HTMLDivElement} */ (document.getElementById('sidebarScrollArea'));
const infoBtnElem = /** @type {HTMLButtonElement} */ (document.getElementById('infoBtn'));
const infoBtnMobileElem = /** @type {HTMLButtonElement} */ (document.getElementById('infoBtnMobile'));
const viewBtnMobileElem = /** @type {HTMLButtonElement} */ (document.getElementById('viewBtnMobile'));
const runRecognizeCheckboxElem = /** @type {HTMLInputElement} */ (document.getElementById('runRecognizeCheckbox'));

const descObj = {
  Grey_1: 'Grayscale input image.',
  Binary_1: 'Binarized input image.',
  Columns_1: 'Partition bounds that column candidates are created from.',
  Columns_2: 'Initial column candidates.',
  Columns_3: 'Final columns.',
  InitialPartitions_1: 'Initial partitions.',
  Partitions_1: 'Final partitions.',
};

const disabledDefaultArr = [
  'VerticalLines_1',
  'Projection_1',
  'VerticalLines_2',
];

viewBtnMobileElem.addEventListener('click', () => {
  if (sidebarAreaElem.classList.contains('d-none')) {
    // mainColElem.setAttribute('style', 'position:relative;overflow-y:scroll;height:95vh;top:5vh')
    mainColElem.classList.add('d-none');
    enableViewCol();
    disableInfoCol();
  } else {
    mainColElem.classList.remove('d-none');
    disableViewCol();
  }
});

function enableViewCol() {
  sidebarAreaElem.classList.remove('d-none');
  viewBtnMobileElem.classList.add('btn-secondary');
  viewBtnMobileElem.classList.remove('btn-light');
}

function disableViewCol() {
  sidebarAreaElem.classList.add('d-none');
  viewBtnMobileElem.classList.remove('btn-secondary');
  viewBtnMobileElem.classList.add('btn-light');
}

function disableInfoCol() {
  infoColElem.classList.add('d-none');
  infoBtnElem.classList.remove('btn-secondary');
  infoBtnElem.classList.add('btn-light');
  infoBtnMobileElem.classList.remove('btn-secondary');
  infoBtnMobileElem.classList.add('btn-light');
}

function enableInfoCol() {
  infoColElem.classList.remove('d-none');
  infoBtnElem.classList.add('btn-secondary');
  infoBtnElem.classList.remove('btn-light');
  infoBtnMobileElem.classList.add('btn-secondary');
  infoBtnMobileElem.classList.remove('btn-light');
}

function toggleInfoBtn() {
  if (infoColElem.classList.contains('d-none')) {
    enableInfoCol();
    disableViewCol();
    mainColElem.classList.add('d-none');
  } else {
    disableInfoCol();
    mainColElem.classList.remove('d-none');
  }
}

infoBtnElem.addEventListener('click', toggleInfoBtn);
infoBtnMobileElem.addEventListener('click', toggleInfoBtn);

const sv = new ScrollView({
  lightTheme: true,
});

const readFileToArrayBuffer = (blob) => (
  new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => {
      resolve(fileReader.result);
    };
    fileReader.onerror = ({ target: { error: { code } } }) => {
      reject(Error(`File could not be read! Code=${code}`));
    };
    fileReader.readAsArrayBuffer(blob);
  })
);

const readFileToString = (blob) => (
  new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => {
      resolve(fileReader.result);
    };
    fileReader.onerror = ({ target: { error: { code } } }) => {
      reject(Error(`File could not be read! Code=${code}`));
    };
    fileReader.readAsText(blob);
  })
);

function createUnorderedListFromObject(obj) {
  // Create an unordered list element
  const ul = document.createElement('ul');

  // Iterate over each property in the object
  for (const [key, value] of Object.entries(obj)) {
    // Create a list item for each key-value pair
    const li = document.createElement('li');
    li.textContent = `${key}: ${value}`;

    // Append the list item to the unordered list
    ul.appendChild(li);
  }

  return ul;
}
const brtDesc = {
  BRT_NOISE: 'Neither text nor image.',
  BRT_HLINE: 'Horizontal separator line.',
  BRT_VLINE: 'Vertical separator line.',
  BRT_RECTIMAGE: 'Rectangular image.',
  BRT_POLYIMAGE: 'Non-rectangular image.',
  BRT_UNKNOWN: 'Not determined yet.',
  BRT_VERT_TEXT: 'Vertical alignment, not necessarily vertically oriented.',
  BRT_TEXT: 'Convincing text.',
};

const bftDesc = {
  BTFT_NONE: 'No text flow set yet.',
  BTFT_NONTEXT: 'Flow too poor to be likely text.',
  BTFT_NEIGHBOURS: 'Neighbours support flow in this direction.',
  BTFT_CHAIN: 'Weak chain of text in this direction.',
  BTFT_STRONG_CHAIN: 'Strong chain of text in this direction.',
  BTFT_TEXT_ON_IMAGE: 'Strong chain of text on an image.',
  BTFT_LEADER: 'Leader dots/dashes etc.',
};

const brtUl = createUnorderedListFromObject(brtDesc);

const bftUl = createUnorderedListFromObject(bftDesc);

infoColElem.appendChild(brtUl);

infoColElem.appendChild(bftUl);

function drawColorSamplesWithLabels(colorMap) {
  const canvas = document.createElement('canvas');
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

  canvas.width = 500;

  const rectHeight = 20; // Height of the color sample rectangle
  const rectWidth = 50; // Width of the color sample rectangle
  const padding = 10; // Padding between color samples
  const textPadding = 130; // Space for the text to the right of the rectangle
  const columnWidth = rectWidth + textPadding;
  const canvasPadding = 10; // Padding on the canvas edges
  const maxColumns = Math.floor((canvas.width - canvasPadding * 2) / columnWidth); // Calculate max columns per row

  let startX = canvasPadding;
  let startY = canvasPadding;
  const rowHeight = rectHeight + padding; // Calculate row height

  // Calculate required canvas height
  const totalColors = Object.keys(colorMap).length;
  const rowsNeeded = Math.ceil(totalColors / maxColumns);
  const requiredCanvasHeight = rowsNeeded * rowHeight + canvasPadding;

  // Adjust canvas height to fit all colors
  canvas.height = requiredCanvasHeight;

  Object.entries(colorMap).forEach(([rgba, name], index) => {
    // Draw color rectangle
    ctx.fillStyle = rgba;
    ctx.fillRect(startX, startY, rectWidth, rectHeight);

    // Draw label
    ctx.fillStyle = 'black';
    ctx.font = '12px Arial';
    ctx.fillText(name, startX + rectWidth + 10, startY + rectHeight / 2 + 5);

    // Update positions for next color
    if ((index + 1) % maxColumns === 0) { // Move to next row after maxColumns
      startX = canvasPadding;
      startY += rowHeight;
    } else { // Move to next column
      startX += columnWidth;
    }
  });

  infoColElem.appendChild(canvas);
}

drawColorSamplesWithLabels(colorsMapping);

function scrollToElem(elemId) {
  const elem = document.getElementById(elemId);
  if (!elem) {
    console.log(`Element with id ${elemId} does not exist.`);
    return;
  }

  // Position the match ~1/3 of the way down the viewer
  mainColElem.scrollTop = elem.offsetTop - mainColElem.offsetHeight / 3;
}

function createSidebarEntry(title, description) {
  // Create the outer div and set its classes
  const outerDiv = document.createElement('div');
  outerDiv.className = 'list-group-item list-group-item-action py-3 lh-tight';
  outerDiv.setAttribute('aria-current', 'true');

  // Create the first inner div with d-flex class and its content
  const innerDiv = document.createElement('div');
  innerDiv.className = 'd-flex w-100 align-items-center justify-content-between';

  // Create and append the strong element to the innerDiv
  const strongElement = document.createElement('strong');
  strongElement.className = 'mb-1';
  strongElement.textContent = title;
  innerDiv.appendChild(strongElement);

  // Create and append the button to the innerDiv
  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.className = 'btn btn-secondary';

  const createSVGElem = (pathArr) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'bi bi-eye-fill');

    for (let i = 0; i < pathArr.length; i++) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathArr[i]);
      svg.appendChild(path);
    }

    return svg;
  };

  // Create the SVG element for the button
  const svgViewEnabled = createSVGElem(['M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0', 'M0 8s3-5.5 8-5.5S16 8 16 8s-3 5.5-8 5.5S0 8 0 8m8 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7']);
  const svgViewDisabled = createSVGElem(['m10.79 12.912-1.614-1.615a3.5 3.5 0 0 1-4.474-4.474l-2.06-2.06C.938 6.278 0 8 0 8s3 5.5 8 5.5a7 7 0 0 0 2.79-.588M5.21 3.088A7 7 0 0 1 8 2.5c5 0 8 5.5 8 5.5s-.939 1.721-2.641 3.238l-2.062-2.062a3.5 3.5 0 0 0-4.474-4.474z',
    'M5.525 7.646a2.5 2.5 0 0 0 2.829 2.829zm4.95.708-2.829-2.83a2.5 2.5 0 0 1 2.829 2.829zm3.171 6-12-12 .708-.708 12 12z']);

  // Create and append the button to the innerDiv
  const buttonBackground = document.createElement('button');
  buttonBackground.setAttribute('type', 'button');
  buttonBackground.className = 'btn btn-secondary';

  if (disabledDefaultArr.includes(title)) {
    button.appendChild(svgViewDisabled);
    outerDiv.classList.add('disabled');
    buttonBackground.classList.add('disabled');
  } else {
    button.appendChild(svgViewEnabled);
  }

  // Prevent button from being disabled when parent element is disabled, since this button disabled/enables the parent element.
  button.setAttribute('style', 'cursor:pointer!important;pointer-events:auto!important');

  button.addEventListener('click', (e) => {
    const listElem = button.parentElement?.parentElement?.parentElement;
    const visElem = document.getElementById(`vis${title}`);
    if (!listElem || !visElem) {
      console.log('Cannot enable/disable element: element(s) not found.');
      return;
    }
    if (listElem.classList.contains('disabled')) {
      listElem.classList.remove('disabled');
      buttonBackground.classList.remove('disabled');
      visElem.classList.remove('d-none');
      button.replaceChild(svgViewEnabled, svgViewDisabled);
    } else {
      listElem.classList.add('disabled');
      buttonBackground.classList.add('disabled');
      visElem.classList.add('d-none');
      button.replaceChild(svgViewDisabled, svgViewEnabled);
    }
    e.stopPropagation();
  });

  const svgBackgroundEnabled = createSVGElem(['M0 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2H2a2 2 0 0 1-2-2z']);
  const svgBackgroundDisabled = createSVGElem(['M0 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2H2a2 2 0 0 1-2-2zm5 10v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2v5a2 2 0 0 1-2 2z']);

  buttonBackground.addEventListener('click', (e) => {
    const canvasBackgroundElem = document.getElementById(`canvasBackground${title}`);
    if (!canvasBackgroundElem) {
      console.log('Cannot show/hide element: element(s) not found.');
      return;
    }

    if (buttonBackground.classList.contains('backgroundDisabled')) {
      canvasBackgroundElem.classList.remove('d-none');
      buttonBackground.classList.remove('backgroundDisabled');
      buttonBackground.replaceChild(svgBackgroundEnabled, svgBackgroundDisabled);
    } else {
      canvasBackgroundElem.classList.add('d-none');
      buttonBackground.classList.add('backgroundDisabled');
      buttonBackground.replaceChild(svgBackgroundDisabled, svgBackgroundEnabled);
    }
    e.stopPropagation();
  });

  buttonBackground.appendChild(svgBackgroundEnabled);

  // Append button to innerDiv
  const buttonGroup = document.createElement('div');
  buttonGroup.classList.add('btn-group');

  buttonGroup.appendChild(button);
  buttonGroup.appendChild(buttonBackground);

  innerDiv.appendChild(buttonGroup);

  // Append innerDiv to outerDiv
  outerDiv.appendChild(innerDiv);

  // Create the second inner div for the paragraph
  const paraDiv = document.createElement('div');
  paraDiv.className = 'col-10 mb-1 small';
  paraDiv.textContent = '';

  if (descObj[title]) paraDiv.textContent = descObj[title];

  // Append the paraDiv to outerDiv
  outerDiv.appendChild(paraDiv);

  outerDiv.addEventListener('click', () => scrollToElem(`vis${title}`));

  // Finally, append the outerDiv to the body or any other container element
  sidebarScrollAreaElem.appendChild(outerDiv); // or any other target element
}

function addCanvasesToDocument(key, value) {
  const offscreenCanvas = value.canvas;
  const offscreenCanvasLegend = value.canvasLegend;

  // Create a label for the canvas
  const cardTitle = document.createElement('h4');
  cardTitle.setAttribute('class', 'card-title');
  cardTitle.textContent = key;

  // Convert OffscreenCanvas to regular canvas and add it to the document
  const canvasBackground = document.createElement('canvas');
  const canvas = document.createElement('canvas');
  canvasBackground.setAttribute('style', 'position:absolute;top:0;left:0;');
  canvas.setAttribute('style', 'position:absolute;top:0;left:0;');

  // Ensure the canvas has the same dimensions as the offscreenCanvas
  canvas.width = offscreenCanvas.width;
  canvas.height = offscreenCanvas.height;
  canvasBackground.width = offscreenCanvas.width;
  canvasBackground.height = offscreenCanvas.height;

  canvasBackground.setAttribute('id', `canvasBackground${key}`);

  // Transfer the content from offscreenCanvas to canvas
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const ctxBackground = /** @type {CanvasRenderingContext2D} */ (canvasBackground.getContext('2d'));

  if (globalThis.imageBitmap) ctxBackground.drawImage(globalThis.imageBitmap, 0, 0);

  ctx.drawImage(offscreenCanvas, 0, 0);

  const div = document.createElement('div');

  const cardElem = document.createElement('div');

  if (disabledDefaultArr.includes(key)) {
    cardElem.setAttribute('class', 'card d-none');
  } else {
    cardElem.setAttribute('class', 'card');
  }

  cardElem.setAttribute('id', `vis${key}`);
  cardElem.setAttribute('style', 'display:inline-block;padding:1rem;margin-top:1rem');

  cardElem.appendChild(cardTitle);

  const canvasContainer = document.createElement('div');
  canvasContainer.setAttribute('style', `position:relative;width:${offscreenCanvas.width}px;height:${offscreenCanvas.height}px`);
  canvasContainer.appendChild(canvasBackground);
  canvasContainer.appendChild(canvas);

  cardElem.appendChild(canvasContainer);

  const cardBody = document.createElement('div');
  cardBody.setAttribute('class', 'card-body');

  if (offscreenCanvasLegend) {
    const canvas = document.createElement('canvas');
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

    canvas.width = offscreenCanvasLegend.width;
    canvas.height = offscreenCanvasLegend.height;

    ctx.drawImage(offscreenCanvasLegend, 0, 0);
    cardElem.appendChild(canvas);
  }

  // Append the canvas to the document
  div.appendChild(cardElem);
  mainColElem.appendChild(div);

  createSidebarEntry(key);
}

const recognize = (evt) => {
  const inputFile = evt.target.files[0];
  if (!inputFile) return;

  TesseractCore().then((TessModule) => {
    const time1 = Date.now();
    const api = new TessModule.TessBaseAPI();
    const lang = 'eng';

    fetch(`./app/tess/${lang}.traineddata`)
      .then((resp) => resp.arrayBuffer())
      .then((buf) => {
        TessModule.FS.writeFile(`${lang}.traineddata`, new Uint8Array(buf));
      })
      .then(async () => {
        const messageDivElem = /** @type {HTMLDivElement} */ (document.getElementById('message'));

        api.Init(null, lang);

        const fileBuf = new Uint8Array(await readFileToArrayBuffer(inputFile));

        const blob = new Blob([fileBuf], { type: 'image/png' });

        // Use createImageBitmap to convert the Blob to ImageBitmap
        globalThis.imageBitmap = await createImageBitmap(blob);

        TessModule.FS.writeFile('/input', fileBuf);
        api.SetImageFile();

        api.SetVariable('tessedit_pageseg_mode', '3');

        api.SetVariable('textord_tabfind_show_blocks', '1');
        api.SetVariable('textord_tabfind_show_strokewidths', '1');
        api.SetVariable('textord_tabfind_show_initialtabs', '1');
        api.SetVariable('textord_tabfind_show_images', '1');
        api.SetVariable('textord_tabfind_show_reject_blobs', '1');
        api.SetVariable('textord_tabfind_show_finaltabs', '1');
        api.SetVariable('textord_tabfind_show_columns', '1');
        api.SetVariable('textord_tabfind_show_initial_partitions', '1');
        api.SetVariable('textord_show_tables', '1');
        api.SetVariable('textord_tabfind_show_partitions', '1');

        // api.SetVariable('textord_debug_tabfind', '1');

        api.SetVariable('show_threshold_images', '1');
        api.SetVariable('textord_tabfind_find_tables', '0');
        api.SetVariable('textord_noise_area_ratio', '1');

        // api.SetVariable('textord_show_final_rows', '1');

        api.SetVariable('vis_file', '/visInstructions.txt');

        if (runRecognizeCheckboxElem.checked) {
          messageDivElem.innerHTML = api.GetUTF8Text();
        } else {
          api.AnalyseLayout();
        }

        const time2 = Date.now();

        console.log(`Used heap size: ${Math.round((performance.memory.usedJSHeapSize) / 1e6)}MB`);
        console.log(`Total heap size: ${Math.round((performance.memory.totalJSHeapSize) / 1e6)}MB`);
        console.log(`Total runtime: ${(time2 - time1) / 1e3}s`);

        const visStr = TessModule.FS.readFile('/visInstructions.txt', { encoding: 'utf8', flags: 'a+' });

        await sv.processVisStr(visStr);

        const visObj = await sv.getAll(true);
        for (const [key, value] of Object.entries(visObj)) {
          addCanvasesToDocument(key, value);
        }

        api.End();
        TessModule.destroy(api);
      });
  });
};

const uploadImageInputElem = /** @type {HTMLInputElement} */ (document.getElementById('uploadImageInput'));
uploadImageInputElem.addEventListener('change', recognize);

const uploadInstructionsInputElem = /** @type {HTMLInputElement} */ (document.getElementById('uploadInstructionsInput'));
uploadInstructionsInputElem.addEventListener('change', async (e) => {
  const inputFile = e.target.files[0];
  if (!inputFile) return;

  const visStr = await readFileToString(inputFile);

  await sv.processVisStr(visStr);

  const visObj = await sv.getAll(true);
  for (const [key, value] of Object.entries(visObj)) {
    addCanvasesToDocument(key, value);
  }
});
