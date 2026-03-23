FROM gptresearcher/gpt-researcher:latest

# Pre-install optional LLM/embedding providers.
# Pin to 0.3.x versions compatible with the base image's langchain-core 0.3.41.
RUN pip install --no-cache-dir \
    "langchain-ollama>=0.3,<0.4" \
    "langchain-anthropic>=0.3,<0.4" \
    ollama
