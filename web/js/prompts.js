// Prompts LLM — extraídos verbatim do CLI (bin/rireki-tailor + bin/gen-pdf).
// O prompt ATS usa o arquivo data/PROMPT_ATS.md (mantém sincronia com o repositório).

let atsBaseCache = null;

async function loadAtsBase() {
  if (atsBaseCache !== null) return atsBaseCache;
  const r = await fetch('data/PROMPT_ATS.md');
  if (!r.ok) throw new Error('Falha ao carregar data/PROMPT_ATS.md: HTTP ' + r.status);
  atsBaseCache = await r.text();
  return atsBaseCache;
}

function buildAtsPrompt(masterCv, lang, jobDesc) {
  const isPt = lang === 'pt';
  return `${atsBaseCache}

---

## LANGUAGE

Generate the CV IN ${isPt ? 'PORTUGUESE (PT-BR)' : 'ENGLISH (EN)'}. All sections, headers, bullet points, and the professional summary must be in ${isPt ? 'Portuguese' : 'English'}.

---

## MASTER CV

Below is the complete master CV. ONLY use information that exists here. NEVER invent skills, experiences, or projects that are not present in this document.

${masterCv}

---

## JOB DESCRIPTION

Below is the job description to optimize the CV for. Extract keywords, map to the master CV, select and reorder the most relevant content.

${jobDesc}

---

Generate the tailored ATS-optimized CV based on the instructions above. Output ONLY the CV markdown, no commentary.`;
}

function buildCoverPrompt(cvOut, lang, jobDesc, pitch) {
  const isPt = lang === 'pt';
  let p = `You are an expert career coach and copywriter specialized in software engineering job applications.

## Your Task

Given a **tailored CV** (already optimized for a specific role) and the **original job description**, write a personal pitch/presentation for the candidate to submit alongside their application.

This is the section where the candidate answers: **"Why this role is for you"** and can freely add anything relevant (presentations, repositories, portfolio links, etc.).

## Output Format

Generate the cover content in this structure:

\`\`\`markdown
# Cover — [Candidate Name] → [Role Title at Company]

## About Me

[1-2 paragraphs. A concise, authentic opening that connects the candidate's background to the role. Use a professional but personal tone. Mention what attracts the candidate to this specific role/company. Do NOT repeat the CV — complement it.]

## Why This Role

- [Bullet: specific skill/experience that directly matches a job requirement]
- [Bullet: project or achievement that proves capability for this role]
- [Bullet: technical fit — stack, domain, or methodology alignment]
- [Bullet: soft fit — team size, remote culture, mission, or growth opportunity]
- [Bullet: any additional differentiator — open source, publications, community work]

## Relevant Links & References

[Only include if the candidate has relevant material mentioned in the CV or that would support this application]

- GitHub: relevant repos or organizations
- Portfolio: projects, talks, or articles
- Anything else that strengthens the application
\`\`\`

## Language

Write IN ${isPt ? 'PORTUGUESE (PT-BR)' : 'ENGLISH (EN)'}.

## Core Rules

1. Base everything on the CV below. If a skill, project, or experience is NOT in the CV, do NOT mention it.
2. Use the job description to understand what the employer values — align the pitch to their language and priorities.
3. Be concise. The whole cover should be scannable in 30 seconds.
4. Tone: confident but not arrogant. Professional but human.
5. Include a placeholder section for extra material (links, repos, presentations) — the candidate can fill or remove it.

---

## TAILORED CV

${cvOut}

---

## JOB DESCRIPTION

${jobDesc}

---

Generate the cover.md content now. Output ONLY the markdown, no commentary.`;
  if (pitch && pitch.trim()) {
    p += `

---

## PERSONAL PITCH INSTRUCTIONS

The candidate has provided the following instructions/guidance for the pitch. Incorporate them into the cover content, following the tone, highlights, and expectations described below:

${pitch}`;
  }
  return p;
}

function buildTexPrompt(cvOut, templateTex) {
  return `You are a LaTeX CV formatter. Fill a markdown CV into a LaTeX template.

## Step 1: Extract the Template Skeleton

Study the LaTeX template below. **IGNORE all sample/placeholder content** — names, emails, skills, job titles, universities, dates, taglines, bios, all of it is fake and irrelevant. Focus ONLY on extracting the **structural skeleton**:

- **Section order and hierarchy:** Which sections exist (Skills, Education, Experience, Awards, Languages, etc.) and in what order do they appear?
- **Layout pattern per section:** How is each section laid out?
  - e.g. Skills -> \\begin{center}\\begin{multicols}{N}\\cvlistitem{...}{...}...\\end{multicols}\\end{center}
  - e.g. Education -> \\begin{multicols}{2}\\cvuniversity{...}{...}{...}{...}\\begin{itemize}...\\end{itemize}\\columnbreak...\\end{multicols}
  - e.g. Experience -> \\cvexperience{...}{...}{...}{...}{...}\\begin{itemize}...\\end{itemize}\\divider
  - e.g. Languages -> \\begin{multicols}{3}\\cvlistitem{...}{...}\\columnbreak...\\end{multicols}
- **Macro signatures:** How many arguments does each command take and what do they represent?
  - \\cvexperience{Title}{Company}{Dates}{Location}{Tags/Keywords}
  - \\cvuniversity{Degree}{Institution}{Dates}{Location}
  - \\cvlistitem{Label}{Description}
  - \\divider (no arguments, horizontal rule separator)
  - \\cvsection{Title}, \\cvsubsection{Title}, \\bio{...}
  - Header: \\name{...}, \\tagline{...}, \\personalinfo{...}, \\email{...}, \\linkedin{...}, \\github{...}, \\location{...}, \\makecvheader
- **Overall structure:** preamble -> \\begin{document} -> header setup -> sections -> \\end{document}

## Step 2: Fill the Skeleton with CV Content

Now take the CV content (markdown below) and adapt it to the template skeleton:

- Map CV sections to template section patterns. Use the **exact same commands and layout patterns** extracted in Step 1.
- Replace all sample data with actual CV data (name, tagline, contact info, bio/summary, skills, experience entries, education, languages).
- If the CV has a section NOT in the skeleton (e.g., Projects), add it using an existing pattern from the skeleton (e.g. \\cvsection + \\cvlistitem + multicols).
- If the skeleton has a section NOT in the CV, **omit it entirely** (e.g., no Awards section if not in CV).

## Rules

- **Do NOT invent new LaTeX commands.** Use only the macros defined in the template's preamble.
- **Escape special LaTeX characters:** &, %, $, #, _, {, } must be properly escaped.
- **Keep ALL preamble code exactly as-is** (\\usepackage, \\definecolor, \\newcommand, \\renewcommand, etc.).
- **Use \\divider between experience entries** as the skeleton shows.
- **Output ONLY the complete, valid .tex source.** No commentary, no markdown wrappers, no code fences. Must compile with pdflatex.

---

## LATEX TEMPLATE

${templateTex}

---

## CV CONTENT (Markdown)

${cvOut}

---

Generate the complete .tex file now. Output ONLY the LaTeX source.`;
}
