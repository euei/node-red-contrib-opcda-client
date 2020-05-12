module.exports = function(RED) {
	const opcda = require('node-opc-da');
	const {ComString} = opcda.dcom;
	
	const errorCode = {
		0x80040154 : "Clsid is not found.",
		0x00000005 : "Access denied. Username and/or password might be wrong.",
		0xC0040006 : "The Items AccessRights do not allow the operation.",
		0xC0040004 : "The server cannot convert the data between the specified format/ requested data type and the canonical data type.",
		0xC004000C : "Duplicate name not allowed.",
		0xC0040010 : "The server's configuration file is an invalid format.",
		0xC0040009 : "The filter string was not valid",
		0xC0040001 : "The value of the handle is invalid. Note: a client should never pass an invalid handle to a server. If this error occurs, it is due to a programming error in the client or possibly in the server.",
		0xC0040008 : "The item ID doesn't conform to the server's syntax.",
		0xC0040203 : "The passed property ID is not valid for the item.",
		0xC0040011 : "Requested Object (e.g. a public group) was not found.",
		0xC0040005 : "The requested operation cannot be done on a public group.",
		0xC004000B : "The value was out of range.",
		0xC0040007 : "The item ID is not defined in the server address space (on add or validate) or no longer exists in the server address space (for read or write).",
		0xC004000A : "The item's access path is not known to the server.",
		0x0004000E : "A value passed to WRITE was accepted but the output was clamped.",
		0x0004000F : "The operation cannot be performed because the object is being referenced.",
		0x0004000D : "The server does not support the requested data rate but will use the closest available rate.",
		0x00000061 : "Clsid syntax is invalid"
	};
	
	const itemTypes = {
		"double" : opcda.dcom.Types.DOUBLE,
		"short" : opcda.dcom.Types.SHORT,
		"integer" : opcda.dcom.Types.INTEGER,
		"float" : opcda.dcom.Types.FLOAT,
		"byte" : opcda.dcom.Types.BYTE,
		"long" : opcda.dcom.Types.LONG,
		"boolean" : opcda.dcom.Types.BOOLEAN,
		"uuid" : opcda.dcom.Types.UUID,
		"string" : opcda.dcom.Types.COMSTRING,
		"char" : opcda.dcom.Types.CHARACTER,
		"date" : opcda.dcom.Types.DATE,
		"currency" : opcda.dcom.Types.CURRENCY,
		"array" : opcda.dcom.Types.ARRAY
	};
    
	function OPCDAWrite(config) {
        RED.nodes.createNode(this,config);
        let node = this;
	
		node.config = config;
		
		let serverNode = RED.nodes.getNode(config.server);
		let opcItemMgr, opcSyncIO, opcGroup;
		let clientHandle = 0;
		let serverHandles = [];
		let items = [];
		
		let writing = false;
		
		if(!serverNode){
			updateStatus("error");
			node.error("Please select a server.")
			return;
		}
		
		serverNode.registerGroupNode(node);
		serverNode.reconnect();		

		async function init(){	
			try{
				serverNode.busy = true;
				reading = false;
				
				opcGroup = await serverNode.opcServer.addGroup(config.id, null);	
				opcItemMgr = await opcGroup.getItemManager();
				opcSyncIO = await opcGroup.getSyncIO();
				
				updateStatus('ready');
			}
			catch(e){
				updateStatus("error");
                onError(e);
				serverNode.reconnect();
			}
			finally{
				serverNode.busy = false;
			}
		}
	
		async function destroy(){
			try {
				serverNode.busy = true;
				if (opcSyncIO) {
                    await opcSyncIO.end();
                    opcSyncIO = null;
                }            
                if (opcItemMgr) {
                    await opcItemMgr.end();
                    opcItemMgr = null;
                }
                
                if (opcGroup) {
                    await opcGroup.end();
                    opcGroup = null;
                }
            } 
			catch (e) {
				updateStatus('error');
                onError(e);
            }
			finally{
				serverNode.busy = false;
			}
		}
		
		async function writeGroup(itemValues){
			
			try{
				writing = true;
				updateStatus("writing");
				
				if(itemValues.length != items.length){
					for(itemValue of itemValues){
						if(!items.includes(itemValue.itemID)){
							clientHandle++;

							var item = [{itemID: itemValue.itemID, clientHandle: clientHandle}];
							var addedItem = await opcItemMgr.add(item);
							
							if ((addedItem[0])[0] !== 0) {
								node.warn(`Error adding item '${item[0].itemID}': ${errorMessage((addedItem[0])[0])}`);
							} 
							else {
								serverHandles[itemValue.itemID] = (addedItem[0])[1].serverHandle;
							}
						}
					}
				}
				
				var objects = [];
				for(itemValue of itemValues){	
					var object = {
						value: itemValue.type == 'string' ? new ComString(itemValue.value, null) : itemValue.value,
						handle: serverHandles[itemValue.itemID],
						type: itemTypes[itemValue.type]
					};
					
					objects.push(object);
				}
								
				await opcSyncIO.write(objects);
				
				var msg = { payload: true };
				node.send(msg);	
				
				updateStatus("ready");
			}
			catch(e){
				updateStatus('error');
				
				var msg = { payload: false };
				node.send(msg);	
                
				onError(e);
			}
			finally{
				writing = false;
			}
		}
		
		node.serverStatusChanged = async function serverStatusChanged(status){
			updateStatus(status);
			if(status == 'connected'){
				await init();
			}
		}

		function updateStatus(status){
			groupStatus = status;
			switch(status){
				case "disconnected":
					node.status({fill:"red",shape:"ring",text:"Disconnected"});
					break;
				case "connecting":
					node.status({fill:"yellow",shape:"ring",text:"Connecting"});
					break;
				case "ready":
					node.status({fill:"green",shape:"ring",text:"Ready"});
					break;
				case "writing":
					node.status({fill:"blue",shape:"ring",text:"Writing"});
					break;
				case "error":
					node.status({fill:"red",shape:"ring",text:"Error"});
					break;
				case "mismatch":
					node.status({fill:"yellow",shape:"ring",text:"Mismatch"});
					break;
				default:
					node.status({fill:"grey",shape:"ring",text:"Unknown"});
					break;
			}
		}
		
		function onError(e){
			var msg = errorMessage(e);
			console.log(e);
			node.error(msg);
		}
		
		function errorMessage(e){
			var msg = errorCode[e] ? errorCode[e] : e.message;
			return msg;
		}
		
		node.on('input', function(msg){
			if(serverNode.isConnected && !writing && opcSyncIO){
				writeGroup(msg.payload);	
			}
        });	
	
		node.on('close', function(){
			destroy();
			serverNode.removeListener("__server_status__");
			done();
		});
    }
	
    RED.nodes.registerType("opcda-write",OPCDAWrite);
}
