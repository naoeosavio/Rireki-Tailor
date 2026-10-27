// RirekiTailor — built-in default templates and seed content.
//
// Offline fallback for the library seed and the first-run section when a
// data/* fetch fails or returns empty (fresh clone, static hosting without
// the file, or an emptied data/ file). Loaded as a global script, the same
// pattern as prompts.js/llm.js/store.js, and exported to Node for checks.

const DEFAULT_TEMPLATES = {
  modern: `% Modelo LaTeX: Moderno Tech (RirekiTailor)
\\documentclass[10pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1.5cm]{geometry}
\\usepackage{xcolor}
\\usepackage{hyperref}
\\usepackage{titlesec}
\\usepackage{enumitem}

\\definecolor{primary}{HTML}{2F6FF2}
\\definecolor{dark}{HTML}{182130}
\\definecolor{gray}{HTML}{5C6875}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlist[itemize]{leftmargin=*,noitemsep,topsep=2pt}

\\titleformat{\\section}{\\large\\bfseries\\color{primary}}{}{0em}{}[\\titlerule]
\\titlespacing*{\\section}{0pt}{10pt}{6pt}

\\begin{document}

{\\LARGE\\bfseries\\color{dark} Mariana Oliveira} \\\\[3pt]
{\\color{primary}\\bfseries Especialista de Produto \\& Marketing Digital} \\\\[2pt]
{\\small\\color{gray} São Paulo, SP $\\cdot$ (11) 98765-4321 $\\cdot$ mariana.oliveira@email.com $\\cdot$ linkedin.com/in/mariana}

\\section*{Resumo Profissional}
Profissional com mais de 5 anos de experiência em gestão de produtos e marketing digital focado em crescimento e retenção. Liderança comprovada em estratégias de CRM, funis de conversão, otimização de SEO e campanhas de alta performance orientadas a dados.

\\section*{Competências Principais}
\\textbf{Estratégia:} Gestão de Ciclo de Vida, Metodologia Ágil (Scrum/Kanban), Análise de Churn, Testes A/B. \\\\
\\textbf{Ferramentas:} Google Analytics 4, HubSpot CRM, Mixpanel, SQL básico, Figma, Jira.

\\section*{Experiência Profissional}
\\textbf{Especialista Sênior de Crescimento} \\hfill \\textit{TechSoluções | 2022 -- Presente}
\\begin{itemize}
  \\item Aumentou a taxa de conversão em 42\\% através da reformulação do onboarding e testes A/B no produto.
  \\item Implementou automações no HubSpot que reduziram o tempo de resposta aos leads em 60\\%.
  \\item Gerenciou time multidisciplinar de 6 pessoas alinhando metas de aquisição e retenção.
\\end{itemize}

\\vspace{4pt}
\\textbf{Analista de Marketing Pleno} \\hfill \\textit{Inovação Digital | 2019 -- 2022}
\\begin{itemize}
  \\item Gerenciou orçamento mensal de R\\$ 80k com ROI sustentado superior a 4.2x.
  \\item Coordenou a estratégia de SEO resultando em crescimento orgânico de 120\\% no tráfego qualificado.
\\end{itemize}

\\section*{Formação Acadêmica}
\\textbf{Bacharelado em Administração de Empresas} \\hfill \\textit{Universidade de São Paulo (USP) | 2015 -- 2019}

\\end{document}`,

  classic: `% Modelo LaTeX: Executivo Clássico (RirekiTailor)
\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=2cm]{geometry}
\\usepackage{hyperref}
\\usepackage{titlesec}
\\usepackage{enumitem}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlist[itemize]{leftmargin=18pt,noitemsep,topsep=2pt}

\\titleformat{\\section}{\\bfseries\\uppercase}{}{0em}{}[\\hrule]
\\titlespacing*{\\section}{0pt}{12pt}{6pt}

\\begin{document}

\\begin{center}
  {\\Huge\\bfseries MARIANA OLIVEIRA} \\\\[4pt]
  São Paulo, SP $\\bullet$ mariana.oliveira@email.com $\\bullet$ (11) 98765-4321 $\\bullet$ linkedin.com/in/mariana
\\end{center}

\\section*{Resumo Profissional}
Executiva de Produto com histórico sólido de resultados na condução de iniciativas de expansão e rentabilidade. Forte habilidade de articulação entre tecnologia, design e metas corporativas.

\\section*{Experiência Profissional}
\\textbf{TechSoluções S.A.} \\hfill \\textit{São Paulo, Brasil} \\\\
\\textbf{Especialista Sênior de Produto} \\hfill \\textit{2022 -- Presente}
\\begin{itemize}
  \\item Liderança da estratégia de retenção de clientes B2B, alcançando redução de 3.5\\% na taxa de churn anual.
  \\item Coordenação de sprints quinzenais com equipes de engenharia e produto garantindo entregas no prazo.
\\end{itemize}

\\vspace{6pt}
\\textbf{Inovação Digital Ltda.} \\hfill \\textit{São Paulo, Brasil} \\\\
\\textbf{Analista de Negócios e Produto} \\hfill \\textit{2019 -- 2022}
\\begin{itemize}
  \\item Mapeamento e automação de processos internos com redução de 30\\% no ciclo de atendimento operacional.
\\end{itemize}

\\section*{Formação Acadêmica}
\\textbf{Universidade de São Paulo (USP)} \\hfill \\textit{2015 -- 2019} \\\\
Bacharel em Administração

\\end{document}`,

  ats: `% Modelo LaTeX: 100% Otimizado para ATS (RirekiTailor)
\\documentclass[10pt,letterpaper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1.8cm]{geometry}
\\usepackage{enumitem}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlist[itemize]{leftmargin=14pt,noitemsep,topsep=1pt}

\\begin{document}

\\begin{center}
  {\\Large\\bfseries Mariana Oliveira} \\\\[2pt]
  São Paulo, SP | mariana.oliveira@email.com | (11) 98765-4321 | linkedin.com/in/mariana
\\end{center}

\\vspace{4pt}
\\textbf{RESUMO} \\\\
Especialista em Marketing de Produto com 5+ anos de atuação. Foco em aumento de conversão, métricas de retenção (NPS/Churn) e alinhamento ágil com squads de tecnologia.

\\vspace{6pt}
\\textbf{HABILIDADES TÉCNICAS E COMPETÊNCIAS} \\\\
CRM (HubSpot, Salesforce), Google Analytics 4, Metodologia Ágil (Scrum), SQL, Testes A/B, Growth Marketing, Liderança de Equipes.

\\vspace{6pt}
\\textbf{EXPERIÊNCIA PROFISSIONAL} \\\\[3pt]
\\textbf{Especialista Sênior de Produto} | TechSoluções (2022 -- Atual)
\\begin{itemize}
  \\item Otimização de funil que elevou a ativação de usuários em 38\\%.
  \\item Gestão de indicadores de performance (KPIs e OKRs) para a diretoria.
\\end{itemize}

\\vspace{3pt}
\\textbf{Analista de Marketing} | Inovação Digital (2019 -- 2022)
\\begin{itemize}
  \\item Gerenciamento de campanhas de tráfego pago com ROI de 4.2x.
  \\item Condução de pesquisas com clientes para descoberta de produto.
\\end{itemize}

\\vspace{6pt}
\\textbf{EDUCAÇÃO} \\\\
Bacharelado em Administração - Universidade de São Paulo (USP) (2015 -- 2019)

\\end{document}`,

  academic: `% Modelo LaTeX: Acadêmico & Pesquisa (RirekiTailor)
\\documentclass[10pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1.6cm]{geometry}
\\usepackage{titlesec}
\\usepackage{enumitem}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\titleformat{\\section}{\\large\\bfseries}{}{0em}{}[\\titlerule]

\\begin{document}

{\\LARGE\\bfseries Mariana Oliveira, M.Sc.} \\\\[2pt]
São Paulo, SP $\\cdot$ mariana@email.com $\\cdot$ Lattes: lattes.cnpq.br/0000

\\section*{Áreas de Interesse}
Gestão de Produto, Transformação Digital, Ciência de Dados Aplicada a Negócios.

\\section*{Formação Acadêmica}
\\textbf{Mestrado em Engenharia de Produção} \\hfill \\textit{USP | 2020 -- 2022} \\\\
Dissertação: Modelagem de Retenção de Clientes em Plataformas Digitais.

\\vspace{4pt}
\\textbf{Graduação em Administração} \\hfill \\textit{USP | 2015 -- 2019}

\\section*{Experiência Profissional e Projetos}
\\textbf{Líder de Projetos Digitais} \\hfill \\textit{TechSoluções | 2022 -- Presente}
\\begin{itemize}[noitemsep,topsep=2pt]
  \\item Aplicação de modelos estatísticos para predição de churn de usuários.
\\end{itemize}

\\section*{Publicações e Certificações}
\\begin{itemize}[noitemsep,topsep=2pt]
  \\item Oliveira, M. (2022). Otimização de Funil em Plataformas SaaS. \\textit{Revista de Gestão e Tecnologia}.
  \\item Certificação Avançada em Analytics e Inteligência de Negócios (2023).
\\end{itemize}

\\end{document}`
};

const DEFAULT_MASTER_CV = `# Mariana Oliveira
São Paulo, SP | (11) 98765-4321 | mariana.oliveira@email.com | linkedin.com/in/mariana

## Resumo Profissional
Especialista em Marketing de Produto e Crescimento com mais de 5 anos de vivência em empresas de tecnologia e startups. Histórico comprovado de liderança em campanhas multicanais, implementação de CRM (HubSpot), redução de churn e elevação de taxas de conversão através de experimentos contínuos e testes A/B.

## Experiência Profissional

### TechSoluções — Especialista Sênior de Produto e Crescimento
*2022 – Atual | São Paulo, SP*
- Liderança de equipe interdisciplinar de 6 pessoas (designers, copywriters e analistas).
- Implementação da estratégia de onboarding que resultou em aumento de 42% na ativação de novos usuários em 6 meses.
- Otimização do funil de vendas integrado com o HubSpot CRM, reduzindo o ciclo de qualificação de leads de 4 dias para 18 horas.
- Condução de mais de 35 testes A/B para aumento de retenção e usabilidade.
- Redução de churn em 3.5% ao ano através de automações de engajamento pós-venda.

### Inovação Digital — Analista de Marketing e Produto Pleno
*2019 – 2022 | São Paulo, SP*
- Gerenciamento de orçamento mensal de tráfego pago (Google Ads, Meta Ads) de R$ 80.000 com ROI médio de 4.2x.
- Criação e coordenação da estratégia de conteúdo e SEO, elevando em 120% os acessos orgânicos qualificados.
- Elaboração de relatórios executivos no Google Analytics 4 e Looker Studio para os diretores da empresa.
- Entrevistas com clientes (user research) para mapeamento da jornada e descoberta de novas funcionalidades de produto.

## Formação Acadêmica
- **Bacharelado em Administração de Empresas** — Universidade de São Paulo (USP), 2015 – 2019.

## Habilidades e Competências
- **Gestão & Métricas:** OKRs, CAC, LTV, Churn Rate, Funis de Conversão, Gestão Ágil (Scrum/Kanban).
- **Ferramentas:** HubSpot CRM, Salesforce, Google Analytics 4, Mixpanel, Looker Studio, Figma, Jira, SQL básico.
- **Idiomas:** Português (Nativo), Inglês (Avançado/Fluente para reuniões e negociações).`;

const DEFAULT_MASTER_CV_EN = `# Mariana Oliveira
São Paulo, SP | (11) 98765-4321 | mariana.oliveira@email.com | linkedin.com/in/mariana

## Professional Summary
Product Marketing and Growth Specialist with 5+ years of experience at technology companies and startups. Proven track record leading multichannel campaigns, implementing CRM (HubSpot), reducing churn, and lifting conversion rates through continuous experimentation and A/B testing.

## Professional Experience

### TechSoluções — Senior Product and Growth Specialist
*2022 – Present | São Paulo, SP*
- Leadership of a cross-functional team of 6 (designers, copywriters, and analysts).
- Implementation of the onboarding strategy that raised new-user activation by 42% in 6 months.
- Optimization of the sales funnel integrated with HubSpot CRM, cutting the lead qualification cycle from 4 days to 18 hours.
- Execution of 35+ A/B tests to lift retention and usability.
- Reduction of churn by 3.5% per year through post-sale engagement automation.

### Inovação Digital — Mid-level Marketing and Product Analyst
*2019 – 2022 | São Paulo, SP*
- Management of a monthly paid-traffic budget (Google Ads, Meta Ads) of R$80,000 with an average ROI of 4.2x.
- Creation and coordination of the content and SEO strategy, growing qualified organic visits by 120%.
- Executive reporting in Google Analytics 4 and Looker Studio for company directors.
- Customer interviews (user research) to map the journey and discover new product features.

## Education
- **Bachelor's Degree in Business Administration** — Universidade de São Paulo (USP), 2015 – 2019.

## Skills and Competencies
- **Management & Metrics:** OKRs, CAC, LTV, Churn Rate, Conversion Funnels, Agile Management (Scrum/Kanban).
- **Tools:** HubSpot CRM, Salesforce, Google Analytics 4, Mixpanel, Looker Studio, Figma, Jira, basic SQL.
- **Languages:** Portuguese (Native), English (Advanced/Fluent for meetings and negotiations).`;

const DEFAULT_ROLE = `Vaga: Especialista de Produto / Growth Marketing
Empresa: Soluções Digitais Brasil
Modalidade: Híbrido (São Paulo)

Descrição da Vaga:
Buscamos um(a) Especialista de Produto e Crescimento para liderar nossas iniciativas de retenção e aquisição de clientes. Você trabalhará em conjunto com nossos times de tecnologia, design e vendas.

Responsabilidades:
- Analisar métricas de funil, conversão e retenção (CAC, LTV, Churn).
- Conduzir testes A/B contínuos para otimizar o produto e a experiência de onboarding.
- Estruturar campanhas de automação no CRM (HubSpot ou similar).
- Colaborar com squads ágeis no desenvolvimento de novas ferramentas.

Requisitos Necessários:
- Experiência sólida em produto digital, growth marketing ou marketing de performance.
- Conhecimento aprofundado em ferramentas de CRM e Analytics (Google Analytics, Mixpanel, etc.).
- Capacidade de analisar dados e apresentar hipóteses claras para a liderança.
- Excelente comunicação interpessoal e experiência com métodos ágeis (Scrum/Kanban).
- Inglês avançado para alinhamento com clientes e fornecedores internacionais.`;

// Display order and library names for the built-in templates.
// The key must match a key of DEFAULT_TEMPLATES.
const DEFAULT_TEMPLATE_META = [
  { key: 'modern', name: 'Moderno Tech & Inovação' },
  { key: 'classic', name: 'Clássico Executivo Sênior' },
  { key: 'ats', name: '100% ATS Minimalista' },
  { key: 'academic', name: 'Acadêmico Projetos & Pesquisa' }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_TEMPLATES: DEFAULT_TEMPLATES,
    DEFAULT_MASTER_CV: DEFAULT_MASTER_CV,
    DEFAULT_MASTER_CV_EN: DEFAULT_MASTER_CV_EN,
    DEFAULT_ROLE: DEFAULT_ROLE,
    DEFAULT_TEMPLATE_META: DEFAULT_TEMPLATE_META
  };
}
