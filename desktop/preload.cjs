const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('autosetter',{chooseModel:()=>ipcRenderer.invoke('choose-model')});
