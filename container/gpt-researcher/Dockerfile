FROM gptresearcher/gpt-researcher:latest

# Pre-install optional LLM/embedding providers.
# Pin to 0.3.x versions compatible with the base image's langchain-core 0.3.41.
RUN pip install --no-cache-dir \
    "langchain-ollama>=0.3,<0.4" \
    "langchain-anthropic>=0.3,<0.4" \
    ollama

# Strip the `temperature` param from every Anthropic call. GPT Researcher always
# sets temperature (default 0.4, gpt_researcher/utils/llm.py), but newer Claude
# models (e.g. Opus 4.7) reject it: 400 "`temperature` is deprecated for this model".
# Patch the single chokepoint where the ChatAnthropic client is built. Build fails
# loudly if upstream changes the line, so this never silently no-ops.
RUN python -c "import pathlib; p=pathlib.Path('/usr/src/app/gpt_researcher/llm_provider/generic/base.py'); s=p.read_text(); old='            llm = ChatAnthropic(**kwargs)'; new='            kwargs.pop(\"temperature\", None)  # Opus 4.7+ reject the temperature param\n'+old; assert old in s, 'anthropic branch not found - upstream base.py changed'; p.write_text(s.replace(old, new, 1)); print('patched: temperature stripped from anthropic provider')"
