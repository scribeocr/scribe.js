import vision from '@google-cloud/vision';

// Creates a client
const client = new vision.ImageAnnotatorClient();

const fileName = 'tests/assets/the_past.png';

// Performs text detection on the local file
const [result] = await client.textDetection(fileName);
const detections = result.textAnnotations;
console.log('Text:');
detections.forEach((text) => console.log(text));
