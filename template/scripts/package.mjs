// Prepare a request for permissions, never an approval or deployment credential.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';

try {
 if (process.argv.length!==3 || !/^sha256:[a-f0-9]{64}$/u.test(process.argv[2])) throw new Error('Provide the exact local image ID: npm run package -- sha256:…');
 const file=await open(new URL('../chest.template.json',import.meta.url),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let template;
 try {
  const stat=await file.stat();
  if (!stat.isFile() || stat.size>16384) throw new Error('Invalid package template');
  template=JSON.parse(await file.readFile('utf8'));
 } finally {await file.close();}
 if (!template || typeof template!=='object' || Array.isArray(template) || Object.keys(template).sort().join(',')!=='name,permissions' || typeof template.name!=='string' || !/^[a-z][a-z0-9-]{0,47}$/u.test(template.name) || !Array.isArray(template.permissions) || template.permissions.length>4 || !template.permissions.every(p=>['record','requests','probe','public-requests'].includes(p)) || new Set(template.permissions).size!==template.permissions.length || (template.permissions.includes('public-requests') && !template.permissions.includes('requests'))) throw new Error('Invalid package template');
 const raw=JSON.stringify({name:template.name,image:process.argv[2],permissions:template.permissions})+'\n';
 await writeFile(new URL('../chest.json',import.meta.url),raw,{flag:'wx',mode:0o600});
 console.log('Package prepared. SHA-256:',createHash('sha256').update(raw).digest('hex'));
 console.log('This digest identifies a request; the Chest owner must approve its permissions.');
} catch(error) {console.error(error instanceof Error?error.message:'Package preparation failed');process.exitCode=1;}
