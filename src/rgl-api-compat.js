/* Compatibilidad mínima con la API usada por la web original. No conecta con Supabase. */
(() => {
  const request = async (path, body) => {
    const r = await fetch(path, {method: body ? "POST" : "GET", credentials:"same-origin",
      headers: body ? {"content-type":"application/json"} : {}, body: body ? JSON.stringify(body) : undefined});
    const j = await r.json().catch(()=>({error:"Respuesta no válida del servidor"}));
    if (!r.ok) throw new Error(j.error || "Error del servidor");
    return j;
  };
  class Query {
    constructor(table){this.table=table;this.action="select";this.filters=[];this.orderBy=null;this.max=1000;this.payload=null;this.wantSingle=false;this.columns="*";}
    select(columns="*"){this.columns=columns;return this;}
    insert(data){this.action="insert";this.payload=data;return this;}
    update(data){this.action="update";this.payload=data;return this;}
    delete(){this.action="delete";return this;}
    eq(column,value){this.filters.push({column,op:"eq",value});return this;}
    order(column,opts={}){this.orderBy={column,ascending:opts.ascending!==false};return this;}
    limit(n){this.max=n;return this;}
    single(){this.wantSingle=true;return this.execute();}
    then(resolve,reject){return this.execute().then(resolve,reject);}
    async execute(){
      try {
        const out=await request("/api/query",{table:this.table,action:this.action,payload:this.payload,filters:this.filters,order:this.orderBy,limit:this.max,columns:this.columns});
        let data=out.data;
        if(this.wantSingle){if(Array.isArray(data))data=data[0]||null;if(!data)throw new Error("No se encontró el registro solicitado.");}
        return {data,error:null};
      } catch(error){return {data:null,error:{message:error.message}};}
    }
  }
  const listeners=[];
  const auth={
    signInWithPassword:async ({email,password})=>{try{const x=await request("/api/login",{email,password});listeners.forEach(f=>f("SIGNED_IN",{user:x.user}));return {data:{user:x.user},error:null};}catch(e){return {data:null,error:{message:e.message}};}},
    signOut:async()=>{try{await request("/api/logout",{});listeners.forEach(f=>f("SIGNED_OUT",null));return {error:null};}catch(e){return {error:{message:e.message}};}},
    getSession:async()=>{try{const x=await request("/api/me");return {data:{session:x.user?{user:x.user}:null},error:null};}catch(e){return {data:{session:null},error:{message:e.message}};}},
    onAuthStateChange:(fn)=>{listeners.push(fn);return {data:{subscription:{unsubscribe(){const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}}}};}
  };
  window.rglApi={createClient:()=>({from:(t)=>new Query(t),auth})};
})();