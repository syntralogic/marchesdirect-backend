// Dry-run by default. --apply is reserved for the approved production change.
// Never reads/writes records, enrolls workflows, or sends any message.
import axios from 'axios';
const properties = [
  {name:'md_email_status',label:'MD — État de l’e-mail du dossier',type:'enumeration',fieldType:'select',
   description:'Accepté par Resend ne garantit pas la remise en boîte de réception. Indépendant de la génération du PDF.',
   options:[['sent','Envoyé — accepté par le prestataire'],['failed','Échec de l’envoi'],['not_configured','Envoi non configuré'],['disabled','Envoi désactivé'],['not_attempted','Envoi non tenté']].map(([value,label],displayOrder)=>({value,label,displayOrder,hidden:false}))},
  {name:'md_last_delivery_error_at',label:'MD — Date de la dernière erreur de dossier',type:'datetime',fieldType:'date',
   description:'Date du nouvel échec de génération ou d’envoi. Les anciennes erreurs ne sont pas réinscrites.'},
  {name:'md_delivery_error_code',label:'MD — Cause de l’erreur de dossier',type:'string',fieldType:'text',
   description:'Code sans donnée personnelle : pdf_generation_failed, email_not_configured ou email_send_failed.'},
];
async function main(){
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({mode:'dry-run',objectType:'deals',properties},null,2));return;}
 const token=process.env.HUBSPOT_ACCESS_TOKEN;
 if(!token)throw new Error('HUBSPOT_ACCESS_TOKEN missing');
 const http=axios.create({baseURL:process.env.HUBSPOT_BASE_URL||'https://api.hubapi.com',timeout:15000,headers:{Authorization:`Bearer ${token}`}});
 const existing=await http.get('/crm/v3/properties/deals/md_dossier_status');
 const groupName=existing.data.groupName;
 for(const property of properties){
  try{
   const found=await http.get(`/crm/v3/properties/deals/${property.name}`);
   if(found.data.type!==property.type)throw new Error(`property_type_mismatch:${property.name}`);
   if('options' in property){const values=new Set((found.data.options||[]).map((o:any)=>o.value));if(property.options?.some(o=>!values.has(o.value)))throw new Error(`property_options_mismatch:${property.name}`);}
   console.log(`${property.name}: already exists`);
  }catch(e:any){
   if(e.response?.status!==404)throw e;
   await http.post('/crm/v3/properties/deals',{...property,groupName});
   console.log(`${property.name}: created`);
  }
 }
}
main().catch((e:any)=>{console.error('Property setup failed',{httpStatus:e.response?.status,code:e.code||'setup_failed'});process.exitCode=1;});
