import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
const marker='/data/created-at';
let created;try{created=await readFile(marker,'utf8')}catch(e){if(e.code!=='ENOENT')throw e;created=new Date().toISOString();await writeFile(marker,created)}
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/health'?{ok:true}:{app:process.env.APP_NAME||'ezdeploy example',dataCreatedAt:created}));});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Application started'));
process.on('SIGTERM',()=>server.close());
