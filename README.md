# RirekiTailor

**RirekiTailor** is an AI-powered pipeline that generates tailored, ATS-optimized CVs and cover letters from your master CV.

It uses **[tell](https://github.com/naoeosavio/Tell-ai)** — a terminal AI assistant — to drive the generation with safe, non-executing mode (`--no-exec`).

## Pipeline

```
[raw career notes]
       │
       ▼
  gen-master ───► data/CV_MASTER_{en,pt}.md   (Stage 0: structure your master CV)
       │
       ▼
  rireki-tailor ───► CV_OUT.md + cover.md     (Stage 1: tailor to a job description)
       │
       ▼
  gen-pdf ───► out/CV_username.pdf        (Stage 2: compile LaTeX → PDF)
```

## Prerequisites

- **[tell](https://github.com/naoeosavio/Tell-ai)** — AI CLI tool (model `-m j`) with a configured API key
- **pdflatex** (optional) — for PDF generation; install via `texlive-latex-base`

## Quick Start

```bash
git clone https://github.com/naoeosavio/RirekiTailor.git
cd RirekiTailor
```

### 1. Create your Master CV

Drop your raw career notes into a file and let the AI structure it:

```bash
./bin/gen-master --en my-notes.md       # English
./bin/gen-master --pt minhas-info.md    # Portuguese
```

The AI reads your unstructured notes and organizes them into the canonical `data/CV_MASTER_{lang}.md` format — with professional summary, skills, experience, projects, education, and ATS keywords. This becomes your **single source of truth**; the AI will never fabricate anything outside it.

### 2. Tailor to a job

Paste the job description into `role.md`, then run:

```bash
./bin/rireki-tailor --en role.md                      # English CV only
./bin/rireki-tailor --pt --cover role.md              # PT CV + cover letter
./bin/rireki-tailor --en --cover --pitch role.md      # Use personal pitch for cover
./bin/rireki-tailor --en --cover --pitch ~/pitches/startup.md ~/vagas/backend.md
```

| Flag | Description |
|------|-------------|
| `--en` / `--pt` | Output language (default: en) |
| `--cover` | Also generate `cover.md` (presentation/pitch) |
| `--pitch [file]` | Guide the cover letter with a personal pitch (default: `pitch.md`) |
| `[file]` | Job description path (default: `role.md`) |

Outputs: `bin/CV_OUT.md` (tailored CV) and `bin/cover.md` (if `--cover`).

### 3. Generate PDF

```bash
./bin/gen-pdf
```

Reads `bin/CV_OUT.md`, fills the LaTeX template at `src/template/CV_ATS.tex`, and compiles:

- `out/CV_username.tex`
- `out/CV_username.pdf`

## Project structure

```
.
├── bin/
│   ├── gen-master          # Stage 0: raw notes → master CV
│   ├── rireki-tailor       # Stage 1: master CV + JD → tailored CV + cover
│   └── gen-pdf             # Stage 2: markdown CV → LaTeX → PDF
├── data/
│   ├── CV_MASTER_EN.md     # Your canonical English master CV
│   ├── CV_MASTER_PT.md     # Your canonical Portuguese master CV
│   └── PROMPT_ATS.md       # System prompt for ATS optimization
├── src/template/
│   └── CV_ATS.tex          # LaTeX skeleton template
├── role.md                 # Paste the target job description here
├── pitch.md                # Personal pitch instructions for cover letters
└── out/                    # Generated PDF artifacts (.tex, .pdf, .aux, .log)
```

## How it works

RirekiTailor uses `tell` with the `--no-exec -i` flags for safe, non-executing AI generation. Each stage constructs a prompt — combining templates, master CV data, and job descriptions — and pipes it to `tell`. The output is cleaned of ANSI codes and code fences, then written to the target file.

| Stage | Script | Input | Output |
|-------|--------|-------|--------|
| 0 | `gen-master` | Raw career notes | `data/CV_MASTER_{lang}.md` |
| 1 | `rireki-tailor` | Master CV + job description | `bin/CV_OUT.md` (+ `bin/cover.md`) |
| 2 | `gen-pdf` | `CV_OUT.md` + LaTeX template | `out/CV_username.pdf` |

## License

MIT
