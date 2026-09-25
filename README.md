# PDF → PLT

POC local em Node.js para interpretar paths vetoriais de um PDF e gerar um arquivo PLT com comandos HP-GL.

## Decisão técnica

O pipeline usa PDF.js (pdfjs-dist) diretamente. A API getOperatorList() expõe os operadores usados para construir paths, incluindo moveTo, lineTo, curveTo, curveTo2, curveTo3, rectangle e closePath.

O UniConvertor não é usado no pipeline principal. A documentação do projeto UniConvertor 2.0 ainda descreve dependências Python 2.x e a ferramenta não fornece uma API Node.js moderna específica para este caso. Para uma POC cujo requisito é preservar paths PDF diretamente, interpretar o OperatorList reduz uma camada de conversão.

## Arquitetura

Browser
  ↓
Express /convert
  ↓
PDF.js getOperatorList()
  ↓
Paths vetoriais em pontos PDF
  ↓
mm
  ↓
HP-GL
  ↓
converted/*.plt

## Estrutura

pdftoplt/
├── package.json
├── server.js
├── README.md
├── .gitignore
├── public/
│   └── index.html
├── src/
│   └── converter.js
├── uploads/
│   └── .gitkeep
└── converted/
    └── .gitkeep

## Instalação

Instalar Node.js 18 ou superior.

Depois:

npm install

Executar:

npm run dev

ou:

npm start

Abrir http://localhost:3000.

## UniConvertor

O UniConvertor é opcional e não é necessário para executar esta POC.

A versão documentada do projeto UniConvertor 2.0 continua com uma instalação baseada em Python e possui limitações de compatibilidade. Antes de tentar usá-lo como etapa intermediária, valide a versão instalada com:

uniconvertor --help

A POC não assume que uniconvertor exista no PATH.

## Unidades e escala

PDF usa 72 pontos por polegada e uma polegada possui 25,4 mm.

Portanto:

1 pt = 25,4 / 72 mm

A implementação usa, por padrão:

HPGL_UNITS_PER_MM = 40

Isso corresponde à convenção clássica de 40 unidades HP-GL por mm. O valor é configurável porque o controlador da máquina de corte é a autoridade final.

Windows PowerShell:

$env:HPGL_UNITS_PER_MM="40"
npm start

Linux:

HPGL_UNITS_PER_MM=40 npm start

A fórmula é:

HP-GL = PDF_points × (25,4 / 72) × HPGL_UNITS_PER_MM

Exemplo:

500 mm × 40 = 20.000 unidades HP-GL

## Sistema de coordenadas

O parser mantém a geometria no sistema do PDF até a geração do HP-GL.

Antes de gerar o arquivo:

1. calcula o bounding box;
2. subtrai o menor X;
3. transforma Y com maxY - Y;
4. converte para unidades HP-GL.

Isso não altera a escala. É somente translação e mudança de orientação do eixo Y.

Exemplo:

Original:
X = 100..600
Y = 200..500

Saída geométrica:
X = 0..500
Y = 0..300

A dimensão permanece 500 × 300 pontos.

## Curvas

HP-GL básico pode representar o trajeto usando movimentos PD entre pontos.

As curvas Bézier cúbicas do PDF são subdivididas recursivamente até uma tolerância configurável.

Padrão:

CURVE_TOLERANCE_MM = 0,01 mm

Para testar outra tolerância:

CURVE_TOLERANCE_MM=0.005 npm start

## Exemplo de PLT

Para um retângulo de 100 mm × 50 mm usando 40 unidades/mm:

IN;
PA;
SP1;
PU0,0;
PD4000,0;
PD4000,2000;
PD0,2000;
PD0,0;
PU;
SP0;

A extensão física esperada é:

100 × 40 = 4000
50 × 40 = 2000

## Teste manual

Crie um PDF de uma página contendo somente um retângulo vetorial de 100 mm × 50 mm.

Pode ser criado em Inkscape, Illustrator, CorelDRAW ou outro editor vetorial:

1. criar uma página;
2. desenhar um retângulo;
3. definir largura de 100 mm;
4. definir altura de 50 mm;
5. exportar como PDF;
6. enviar para a POC.

O retorno esperado é aproximadamente:

widthMm = 100.00
heightMm = 50.00

Depois abra o PLT em um editor de texto e verifique os comandos HP-GL.

A validação física deve ser feita primeiro em simulador/software de plotter e somente depois no equipamento.

## Limitações

- somente uma página;
- somente geometria vetorial;
- imagem raster não é convertida em linhas;
- texto não convertido para paths é ignorado;
- cores não selecionam ferramenta;
- efeitos gráficos complexos não são interpretados como semântica de corte;
- strokes especiais podem exigir regras adicionais;
- a POC não conhece a área útil da máquina;
- a convenção de origem/unidades do controlador precisa ser validada;
- coordenadas HP-GL são quantizadas para unidades inteiras;
- não existe nesting, offset de faca, compensação de kerf ou otimização de ordem de corte.

## Segurança

- limite de upload de 25 MB;
- extensão PDF obrigatória;
- MIME validado quando disponível;
- nome temporário sanitizado e com UUID;
- download protegido por path.basename;
- PDF temporário removido após o processamento;
- PLTs com mais de 24 horas são removidos;
- ferramentas externas, quando usadas futuramente, devem ser executadas com spawn e shell=false.

## Próximos passos

1. validar o arquivo contra o manual do plotter de destino;
2. testar origem, orientação e unidade com uma geometria pequena;
3. validar em simulador;
4. criar fixtures de 100 × 50 mm, círculos e Bézier;
5. comparar automaticamente dimensões PDF versus PLT;
6. separar paths de corte de marcas e arte-final;
7. adicionar ordenação de trajetórias;
8. avaliar comandos HP-GL de arco;
9. adicionar limites da máquina;
10. adicionar testes de regressão;
11. tratar de forma mais rigorosa UserUnit, rotação e boxes do PDF;
12. somente depois considerar uso produtivo.

Esta POC gera instruções HP-GL reais a partir da geometria vetorial; não rasteriza o PDF nem apenas troca a extensão do arquivo.
