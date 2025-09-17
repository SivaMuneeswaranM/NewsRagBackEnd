import { indexDocuments } from '../rag.js';
const now = new Date().toISOString();
const docs = [
  { id:'s1', url:'https://local/markets', title:'Markets wrap', publishedAt:now, text:'Global stocks were mixed while investors assessed central bank commentary and energy prices.' },
  { id:'s2', url:'https://local/gold',    title:'Gold prices edge higher', publishedAt:now, text:'Spot gold steadied as a softer dollar offset higher yields ahead of the Fed decision.' },
  { id:'s3', url:'https://local/china',   title:'China policy update', publishedAt:now, text:'China signaled support measures for the property sector and local government financing.' }
];
const res = await indexDocuments(docs);
console.log(`Seeded ${res.inserted} chunks into ${process.env.QDRANT_COLLECTION}`);
