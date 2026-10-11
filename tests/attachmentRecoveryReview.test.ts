import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomEngine, type EngineData } from '../src/domain.ts';
import { saveAttachment, CHUNK_SIZE } from '../src/attachments.ts';
import { RoomObject } from '../src/objects.ts';
import type { ServerMessage } from '../protocol/index.ts';

const host = {profileId: 1, login: 'Host', avatar: null};
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
async function fixture() {
    const engine = RoomEngine.create({roomId:'review-room',joinCode:'12345678',title:'Review',visibility:'public',host},Date.now());
    engine.connect(host,Date.now());
    const data = new Map<string, unknown>([['engine',engine.exportData()]]);
    let fault: 'attachment-write'|'engine-write'|'attachment-delete'|null = null;
    let socketsPresent = true;
    let directoryDown = false, alarm: number|null = null, ready = Promise.resolve();
    const received: ServerMessage[] = [];
    let socketAttachment = {profileId:1,connectionId:'test',window:Date.now(),messages:0,lastSeen:Date.now()};
    const ws = {deserializeAttachment:()=>structuredClone(socketAttachment), serializeAttachment:(a:typeof socketAttachment)=>{socketAttachment=structuredClone(a);},send:(raw:string)=>{received.push(JSON.parse(raw));},close:()=>{}} as unknown as WebSocket;
    const store = {
        async get(key:string|string[]) {return Array.isArray(key)?new Map(key.filter(k=>data.has(k)).map(k=>[k,structuredClone(data.get(k))])):structuredClone(data.get(key));},
        async put(key:string|Record<string,unknown>,value?:unknown) {
            const entries = typeof key === 'string'?[[key,value]] as [string,unknown][]:Object.entries(key);
            if((fault==='attachment-write' && entries.some(([k])=>k.startsWith('att:chunk:'))) || (fault==='engine-write' && entries.some(([k])=>k==='engine'))) {fault=null;throw new Error('injected write failure');}
            for(const [k,v] of entries)data.set(k,structuredClone(v));
        },
        async delete(key:string|string[]) {const keys=Array.isArray(key)?key:[key];if(fault==='attachment-delete'&&keys.some(k=>k.startsWith('att:'))){fault=null;throw new Error('injected delete failure');}let removed=0;for(const k of keys)removed+=Number(data.delete(k));return Array.isArray(key)?removed:removed>0;},
        async list(options?:{prefix?:string;limit?:number;startAfter?:string}) {return new Map([...data].sort(([a],[b])=>a.localeCompare(b)).filter(([k])=>(!options?.prefix||k.startsWith(options.prefix))&&(!options?.startAfter||k>options.startAfter)).slice(0,options?.limit));},
        async transaction(callback:(storage:unknown)=>Promise<unknown>) {const snapshot=structuredClone(data);try{return await callback(store);}catch(error){data.clear();for(const [k,v]of snapshot)data.set(k,v);throw error;}},
        async deleteAll(){data.clear();},async setAlarm(time:number){alarm=time;},async deleteAlarm(){alarm=null;},async getAlarm(){return alarm;},
    };
    const ctx={storage:store,blockConcurrencyWhile:(callback:()=>Promise<void>)=>{ready=callback();return ready;},getWebSockets:()=>socketsPresent?[ws]:[]} as unknown as ConstructorParameters<typeof RoomObject>[0];
    const env={DIRECTORY:{idFromName:()=>'',get:()=>({fetch:async()=>directoryDown?new Response(null,{status:503}):Response.json({ok:true})})}} as unknown as ConstructorParameters<typeof RoomObject>[1];
    let object = new RoomObject(ctx,env);await ready;
    return {
        data, received,
        async seedMessages(count:number){const copy=new RoomEngine(data.get('engine') as EngineData);for(let i=0;i<count;i++)copy.addChatMessage({id:`seed-${i}`,profileId:1,login:'Host',avatar:null,text:`Seed ${i}`,createdAt:Date.now()});data.set('engine',copy.exportData());await this.recreate();},
        detachSockets(){socketsPresent=false;},
        fault(value:typeof fault){fault=value;},directoryDown(){directoryDown=true;},alarm:()=>alarm,
        async upload(id='upload-1',text='Caption',mime='image/png') {
            return object.fetch(new Request('https://internal/attachment-commit',{method:'POST',headers:{'X-Profile':JSON.stringify(host),'content-type':mime,'X-Attachment-Kind':'image','X-Attachment-Name':'test.png','X-Attachment-Upload-Id':id,'X-Attachment-Text':encodeURIComponent(text)},body:PNG}));
        },
        async sendText(){await object.webSocketMessage(ws,JSON.stringify({type:'chat_message',text:'Evicts old image',commandId:'evict-review',mediaVersion:0}));},
        async close() {await object.webSocketMessage(ws,JSON.stringify({type:'close_room',commandId:'close-review',mediaVersion:0}));},
        async retryAlarm(){await object.alarm();},
        async disconnect(){socketsPresent=false;await object.webSocketClose(ws);},
        async recreate(){object=new RoomObject(ctx,env);await ready;},
    };
}
for(const failure of ['attachment-write','engine-write'] as const) {
    test(`attachment atomicity: ${failure} failure creates no orphan and retry creates exactly one message`,async()=>{
        const f=await fixture();f.fault(failure);
        try{const response=await f.upload();assert.ok(response.status>=500);}catch(error){assert.match(String(error),/injected write failure/);}
        assert.equal([...f.data.keys()].filter(k=>k.startsWith('att:chunk:')||k.startsWith('att:meta:')||k.startsWith('att:upload:')).length,0,'no orphan binary or receipt');
        assert.equal((f.data.get('engine') as EngineData).state.chat.length,0,'no published dangling attachment');
        const retry=await f.upload();assert.equal(retry.status,200);await retry.json();
        assert.equal((f.data.get('engine') as EngineData).state.chat.length,1,'in-memory rollback also correct');
        await f.recreate();assert.equal((await f.upload()).status,200);
        assert.equal((f.data.get('engine') as EngineData).state.chat.length,1,'durable receipt prevents retry duplicates');
    });
}
test('closure deletes all file keys despite unavailable room directory',async()=>{
    const f=await fixture();assert.equal((await f.upload()).status,200);f.directoryDown();await f.close();
    assert.equal([...f.data.keys()].filter(k=>k.startsWith('att:')).length,0,'directory failure does not retain bytes');
    assert.ok(f.received.findIndex(m=>m.type==='ack') < f.received.findIndex(m=>m.type==='room_closed'),'ack precedes terminal event');
    assert.notEqual(f.alarm(),null,'durable directory retry remains scheduled');
});
test('failed attachment erase on closure schedules durable cleanup retry and denies new files',async()=>{
    const f=await fixture();assert.equal((await f.upload()).status,200);f.fault('attachment-delete');f.detachSockets();
    try{await f.close();}catch{/* cleanup must be durable even if first attempt fails */}
    assert.notEqual(f.alarm(),null,'retry alarm survives cleanup exception');
    assert.equal((await f.upload('after-close')).status,410,'failed cleanup does not reopen the room');
    await f.recreate();await f.retryAlarm();
    assert.equal([...f.data.keys()].filter(k=>k.startsWith('att:')).length,0,'retry erases every binary key');
});
test('upload UUID conflicting caption must fail across object recreation',async()=>{
    const f=await fixture();assert.equal((await f.upload()).status,200);await f.recreate();
    assert.equal((await f.upload('upload-1','Changed caption')).status,409);
    assert.equal((f.data.get('engine') as EngineData).state.chat.length,1);
});

test('empty room expiration erases binary chunks and receipts without any live sockets',async()=>{
    const f=await fixture();assert.equal((await f.upload()).status,200);await f.disconnect();
    const now=Date.now;const expiredAt=now()+600_001;Date.now=()=>expiredAt;
    try {await f.retryAlarm();}finally {Date.now=now;}
    assert.equal([...f.data.keys()].filter(k=>k.startsWith('att:')).length,0);
    assert.equal(f.data.get('closed'),true);
    assert.equal((await f.upload('expired')).status,410);
});

test('failed commit rolls back history eviction and keeps the previously retained image bytes',async()=>{
    const f=await fixture();const original=(await (await f.upload()).json()).message;
    await f.seedMessages(49);f.fault('engine-write');
    try{await f.upload('replacement');assert.fail('expected failure');}catch(error){assert.match(String(error),/injected write failure/);}
    assert.equal((f.data.get('engine') as EngineData).state.chat.length,50);
    assert.ok(f.data.has(`att:meta:${original.attachment.id}`));
    assert.deepEqual(f.data.get(`att:chunk:${original.attachment.id}:0`),PNG);
    assert.equal([...f.data.keys()].filter(k=>k.startsWith('att:meta:')).length,1);
});
test('declared MIME cannot disguise actual attachment bytes',async()=>{
    const f=await fixture();assert.equal((await f.upload('mismatch','Caption','image/jpeg')).status,400);
    assert.equal([...f.data.keys()].filter(k=>k.startsWith('att:meta:')).length,0);
});

test('a text message that evicts an image deletes its chunks and upload receipt',async()=>{
    const f=await fixture();assert.equal((await f.upload()).status,200);await f.seedMessages(49);
    await f.sendText();
    assert.equal((f.data.get('engine') as EngineData).state.chat.length,50);
    assert.equal([...f.data.keys()].filter(k=>/^att:(meta|chunk|upload):/.test(k)).length,0);
    assert.ok(f.received.some(message=>message.type==='ack'));
});

test('attachment chunks own bounded buffers rather than serializing the entire original file buffer',async()=>{
    const bytes=new Uint8Array(5_000_000);let count=0;
    const storage={put:async(values:Record<string,unknown>)=>{
        for(const [key,value] of Object.entries(values))if(key.startsWith('att:chunk:')){
            const chunk=value as Uint8Array;count++;
            assert.ok(chunk.byteLength<=CHUNK_SIZE);
            assert.equal(chunk.buffer.byteLength,chunk.byteLength,'each stored value owns only its chunk bytes');
        }
    }} as unknown as Parameters<typeof saveAttachment>[0];
    await saveAttachment(storage,{id:'chunks',roomId:'room',kind:'image',mimeType:'image/png',size:bytes.length,name:'file.png',profileId:1,createdAt:Date.now(),chunkCount:0,messageId:'message'},bytes,'upload','hash');
    assert.equal(count,Math.ceil(bytes.length/CHUNK_SIZE));
});
