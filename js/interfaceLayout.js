import { getRandomAlphanum } from "./miscUtils.js";

import { displayPage } from "../main.js";

export function addLayoutBoxClick() {

    canvas.__eventListeners = {}

    let init = false;

    let rect;
    let id;
    let textbox;
    let origX, origY;

    canvas.on('mouse:down', function (o) {

        // Unique ID of layout box, used to map canvas objects to under-the-hood data structures
        id = getRandomAlphanum(10);

        let pointer = canvas.getPointer(o.e);
        origX = pointer.x;
        origY = pointer.y;
        rect = new fabric.Rect({
            left: origX,
            top: origY,
            originX: 'left',
            originY: 'top',
            angle: 0,
            fill: 'rgba(0,0,255,0.25)',
            transparentCorners: false,
            lockMovementX: false,
            lockMovementY: false,
            id: id,
            scribeType: "layoutRect"
            // preserveObjectStacking: true
        });
        rect.hasControls = true;
        rect.setControlsVisibility({ bl: true, br: true, mb: true, ml: true, mr: true, mt: true, tl: true, tr: true, mtr: false });

        textbox = new fabric.IText("1", {
            left: origX,
            top: origY,
            originX: "center",
            originY: "center",
            textBackgroundColor: 'rgb(255,255,255)',
            fontSize: 150,
            id: id,
            scribeType: "layoutTextbox"

        });

        textbox.hasControls = true;
        textbox.setControlsVisibility({ bl: false, br: false, mb: false, ml: true, mr: true, mt: false, tl: false, tr: false, mtr: false });


        rect.on({ 'moving': onChange })
        rect.on({ 'scaling': onChange })

        function onChange(obj) {
            const target = obj.transform.target;

            // Adjust location of textbox
            textbox.left = (target.aCoords.tl.x + target.aCoords.br.x) * 0.5;
            textbox.top = (target.aCoords.tl.y + target.aCoords.br.y) * 0.5;
            textbox.setCoords();
        }

        rect.on({ "mouseup": updateLayoutBoxes })

        function updateLayoutBoxes(obj) {
            const target = obj.target;
            const id = target.id;

            globalThis.layout[currentPage.n]["boxes"][id]["coords"] = [target.aCoords.tl.x, target.aCoords.tl.y, target.aCoords.br.x, target.aCoords.br.y];
            globalThis.layout[currentPage.n]["default"] = false;
        }

        textbox.on('editing:exited', async function (obj) {
            if (this.hasStateChanged) {
                const id = this.id;
                globalThis.layout[currentPage.n]["boxes"][id]["priority"] = parseInt(this.text);
                globalThis.layout[currentPage.n]["default"] = false;
            }
        });

        canvas.add(rect);
        canvas.add(textbox);


        // canvas.add(rect);
        canvas.renderAll();

        canvas.on('mouse:move', function (o) {

            let pointer = canvas.getPointer(o.e);

            if (origX > pointer.x) {
                rect.set({ left: Math.abs(pointer.x) });

            }
            if (origY > pointer.y) {
                rect.set({ top: Math.abs(pointer.y) });

            }

            rect.set({ width: Math.abs(origX - pointer.x) });
            rect.set({ height: Math.abs(origY - pointer.y) });

            textbox.left = rect.left + rect.width * 0.5;
            textbox.top = rect.top + rect.height * 0.5;

            canvas.renderAll();

        });

    });

    canvas.on('mouse:up:before', async function (o) {

        canvas.__eventListeners = {}

        // Immediately select rectangle (showing controls for easy resizing)
        canvas.on('mouse:up', async function (o) {
            if (!init) {
                canvas.setActiveObject(rect);
                canvas.__eventListeners = {}
                globalThis.layout[currentPage.n]["boxes"][id] = {
                    priority: parseInt(textbox.text),
                    coords: [rect.aCoords.tl.x, rect.aCoords.tl.y, rect.aCoords.br.x, rect.aCoords.br.y],
                    type: "order"
                };
                init = true;
            }
        });

    });

}

export function deleteLayoutBoxClick() {
    const delIds = getSelectedLayoutBoxIds();

    deleteLayoutBoxes(delIds);
}

export function getSelectedLayoutBoxIds() {
    const selectedObjects = window.canvas.getActiveObjects();
    const selectedN = selectedObjects.length;
    const ids = [];

    // Identify relevant IDs to be deleted
    // Identifying IDs is done separately from actually deleting as the user may have only
    // selected the rectangle OR textbox, so some relevant objects will not be in `selectedObjects`.
    for (let i = 0; i < selectedN; i++) {
        if (["layoutRect", "layoutTextbox"].includes(selectedObjects[i]["scribeType"])) {
            const id = selectedObjects[i]["id"];
            ids.push(id);
        }
    }

    return ids;
}

// Given an array of layout box ids on current page, 
// delete both the related canvas objects and underlying data. 
export function deleteLayoutBoxes(ids, deleteData = true, renderAll = true) {
    if (ids.length == 0) return;

    // Delete boxes in underlying data structure
    if (deleteData) {
        for (let i=0; i<ids.length; i++) {
            delete globalThis.layout[currentPage.n]["boxes"][ids[i]];
        }
    }
    
    // Delete relevant objects on canvas
    globalThis.layout[currentPage.n]["default"] = false;

    const allObjects = window.canvas.getObjects();
    const n = allObjects.length;
    // Delete any remaining objects that exist with the same id
    // This causes the textbox to be deleted when the user only has the rectangle selected (and vice versa)
    for (let i = 0; i < n; i++) {
        if (ids.includes(allObjects[i]["id"])) {
            window.canvas.remove(allObjects[i]);
        }
    }

    if (renderAll) canvas.renderAll();

}

export function setDefaultLayoutClick() {
    globalThis.layout[currentPage.n]["default"] = true;
    globalThis.defaultLayout = structuredClone(globalThis.layout[currentPage.n]["boxes"]);
    for (let i = 0; i < globalThis.layout.length; i++) {
        if (globalThis.layout[i]["default"]) {
            globalThis.layout[i]["boxes"] = structuredClone(globalThis.defaultLayout);
        }
    }
}

export function revertLayoutClick() {
    globalThis.layout[currentPage.n]["default"] = true;
    globalThis.layout[currentPage.n]["boxes"] = structuredClone(globalThis.defaultLayout);
    displayPage(currentPage.n);
}


export function setLayoutBoxTypeClick(type) {

    const ids = getSelectedLayoutBoxIds();

    if (ids.length == 0) return;

    const idsChange = [];

    for (let i=0; i<ids.length; i++) {
        if (globalThis.layout[currentPage.n]["boxes"][ids[i]].type != type) {
            idsChange.push(ids[i]);
            globalThis.layout[currentPage.n]["boxes"][ids[i]].type = type;
        }
    }

    if (idsChange.length == 0) return;

    deleteLayoutBoxes(idsChange, false, false);

    renderLayoutBoxes(idsChange);

}


export function renderLayoutBoxes(ids, renderAll = true) {
    if (ids.length == 0) return;

    for (let i=0; i<ids.length; i++) {
        renderLayoutBox(ids[i])
    }

    if (renderAll) canvas.renderAll();
}


function renderLayoutBox(id) {
    const obj = globalThis.layout[currentPage.n]["boxes"][id];

    const origX = obj["coords"][0];
    const origY = obj["coords"][1];
    const width = obj["coords"][2] - obj["coords"][0];
    const height = obj["coords"][3] - obj["coords"][1];

    // "Order" boxes are blue, "exclude" boxes are red
    const fill = obj["type"] == "order" ? 'rgba(0,0,255,0.25)' : 'rgba(255,0,0,0.25)';

    const rect = new fabric.Rect({
      left: origX,
      top: origY,
      width: width,
      height: height,
      originX: 'left',
      originY: 'top',
      angle: 0,
      fill: fill,
      transparentCorners: false,
      lockMovementX: false,
      lockMovementY: false,
      id: id,
      scribeType: "layoutRect"
      // preserveObjectStacking: true
    });
    rect.hasControls = true;
    rect.setControlsVisibility({bl:true,br:true,mb:true,ml:true,mr:true,mt:true,tl:true,tr:true,mtr:false});

    // "Order" boxes include a textbox for displaying and editing the priority of that box
    let textbox;
    if (obj["type"] == "order") {
        textbox = new fabric.IText(String(obj["priority"]), {
            left: Math.round(origX + width * 0.5),
            top: Math.round(origY + height * 0.5),
            originX: "center",
            originY: "center",
            textBackgroundColor: 'rgb(255,255,255)',
            fontSize: 150,
            id: id,
            scribeType: "layoutTextbox"
      
          });      
      
          textbox.hasControls = true;
          textbox.setControlsVisibility({bl:false,br:false,mb:false,ml:true,mr:true,mt:false,tl:false,tr:false,mtr:false});
            
          function onChange(obj) {
            const target = obj.transform.target;
      
            // Adjust location of textbox
            textbox.left = (target.aCoords.tl.x + target.aCoords.br.x) * 0.5;
            textbox.top = (target.aCoords.tl.y + target.aCoords.br.y) * 0.5;        
            textbox.setCoords();
          }

          rect.on({'moving': onChange})
          rect.on({'scaling': onChange})

          textbox.on('editing:exited', async function (obj) {
            if (this.hasStateChanged) {
              const id = this.id;
              globalThis.layout[currentPage.n]["boxes"][id]["priority"] = parseInt(this.text);
            }
          });      
      
    }


    rect.on({"mouseup": updateLayoutBoxes})

    function updateLayoutBoxes(obj) {
      const target = obj.target;
      const id = target.id;

      globalThis.layout[currentPage.n]["boxes"][id]["coords"] = [target.aCoords.tl.x, target.aCoords.tl.y, target.aCoords.br.x, target.aCoords.br.y];
    }
    
    canvas.add(rect);
    if (obj["type"] == "order") canvas.add(textbox);

}