NewsRagBackEnd

Backend service for a Retrieval-Augmented Generation (RAG) news chatbot. It exposes simple HTTP endpoints to chat over recent/news documents, handling retrieval, ranking, and LLM synthesis.

Pair this with the NewsRagFrontEnd React app. The frontend expects a /chat endpoint returning JSON (see API).

Features

Stateless HTTP API for chat over news content.

Modular retrieval pipeline (ingest → embed → store → query).

Pluggable vector store and embedding models.

Optional streaming responses for better UX.

Lightweight auth via API key or CORS-only for local dev.

Tech Stack

Python 3.10+

FastAPI + Uvicorn

Sentence-transformers / OpenAI embeddings (configurable)

Vector DB: ChromaDB (default) or Pinecone (optional)

Requests/HTTPX for news ingestion (optional)

Quick Start

Create and activate a venv
python -m venv .venv
source .venv/bin/activate (Windows: .venv\Scripts\activate)

Install dependencies
pip install -r requirements.txt
or
pip install fastapi uvicorn chromadb httpx python-dotenv

Set environment (see .env.example below)
cp .env.example .env
edit .env to add keys and settings

Run the API
uvicorn app.main:app --reload --port 8000
Server on http://localhost:8000
