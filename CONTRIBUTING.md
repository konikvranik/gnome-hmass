# Přispívání

Díky za zájem o příspěvek!

**Všechny pokyny pro práci s kódem — konvence, příkazy, tvrdá pravidla,
testy, ladění i git workflow — jsou v [AGENTS.md](AGENTS.md).** Platí úplně
stejně pro lidské přispěvatele i AI asistenty (Claude Code, opencode,
Antigravity, ZCode, Junie…); vstupní soubory agentů (`CLAUDE.md`,
`GEMINI.md`) ho jen importují, takže pravidla existují právě jednou.

Stručně:

- **čeština** pro komentáře, UI, dokumentaci a commit message; **angličtina**
  pro identifikátory a logy
- `make check` a `make test` musí projít (nová funkce = i nový test)
- jedna logická změna = jeden commit, formát `oblast: co` v imperativu
- PR popište co a proč; přiložte výstup testů
- chovejte se zdvořile — řídíme se [Kodexem chování GNOME](https://conduct.gnome.org/)

Pokud přidáváte podporu novějšího GNOME (45+ vyžaduje ESM), držte obě
varianty odděleně a uvádějte jen verze, které jste skutečně otestovali.
