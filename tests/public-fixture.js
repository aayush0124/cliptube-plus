'use strict';
// Explicitly invoked permitted public fixture, never an arbitrary earlier user URL.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Engine,Queue}=require('../lib/engine');
const {discover,status}=require('../lib/tools');
const ROOT=path.resolve(__dirname,'..');
const URL='https://download.blender.org/peach/trailer/trailer_720x405.mov';
const folder=path.join(ROOT,'test-output','public-fixture');
fs.mkdirSync(folder,{recursive:true});
async function main(){
  const tools=discover(ROOT),dependencyStatus=await status(tools);assert.equal(dependencyStatus.ready,true);
  const engine=new Engine(tools),info=await engine.inspect(URL).promise;
  assert.equal(info.choices[0].width,720);assert.equal(info.choices[0].height,405);
  const report={testedAt:new Date().toISOString(),fixture:URL,license:'CC BY 3.0',attribution:'© Blender Foundation | www.bigbuckbunny.org',licenseSource:'https://peach.blender.org/about/',tools:dependencyStatus,inspection:info,transitions:[]};
  const queue=new Queue({stateDir:path.join(folder,'state'),outputDir:path.join(folder,'downloads'),engine,onChange:s=>{const j=s.jobs.at(-1);if(j && report.transitions.at(-1)!==j.status){report.transitions.push(j.status);console.log(j.status,j.stage);}}});
  const job=queue.add(info,'best');
  const until=Date.now()+180000;
  while(!['completed','failed','canceled'].includes(queue.get(job.id).status)){
    if(Date.now()>until){queue.cancel(job.id);throw new Error('Permitted fixture timed out.');}
    await new Promise(r=>setTimeout(r,150));
  }
  report.job=queue.get(job.id);queue.close();
  fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
  assert.equal(report.job.status,'completed',report.job.error);
  const probe=report.job.verification;
  assert.equal(probe.width,720);assert.equal(probe.height,405);assert.equal(probe.audioCodec,'aac');assert.ok(Math.abs(probe.duration-33.023333)<0.1);
  console.log('PASS public CC BY source: 720×405, AAC, '+probe.duration+' seconds; no re-encoding.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
