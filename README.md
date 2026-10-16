# Kerub

Medidor de dano do AION 2, com o histórico das lutas, a página de qualquer
personagem e o mapa de Atreia. O nome é o dos Kerubs, os bichinhos curiosos de
Atreia que ficam rodando e olhando tudo.

Roda só no seu computador: lê os pacotes do jogo, não mexe no jogo e não
manda nada para lugar nenhum.

São duas janelas:

- **Client**: a luta ao vivo, o histórico de todas as lutas, os recordes, a
  busca de personagens, o mapa e as escolhas do overlay.
- **Overlay** por cima do jogo, com as colunas que você escolher. Dá para
  desligar (em PC mais fraco ele pesa): o client continua gravando tudo.

## Como usar

1. Instale o [Npcap](https://npcap.com) marcando **"WinPcap API-compatible
   Mode"**. Se ele não estiver instalado, o Kerub mostra o botão **Instalar
   Npcap**, que baixa o instalador oficial.
2. Abra o `kerub.exe`. Ele pede administrador, porque a captura precisa.
3. Abra o Kerub **antes** de entrar na zona ou dungeon: os nomes dos jogadores
   só chegam quando você entra numa zona.
4. Para o overlay aparecer por cima do jogo, deixe o jogo em janela sem bordas
   (borderless).

Requisitos: Windows 10 ou 11 (o WebView2 já vem no Windows 11). O exe é um
arquivo só: a interface e os nomes de skills e chefes vão dentro dele.

## O que tem

### Uma luta (ao vivo ou do histórico)

- **Dano**: cada jogador com DPS, parte do dano, crítico, nível de item e poder
  de combate (de quem está no seu grupo). Clique num jogador para ver as taxas
  dele (crítico, perfeito, duplo, costas, golpe múltiplo), a skill que mais deu
  dano e a tabela de skills (golpes, crítico, perfeito, duplo, costas, frontal,
  aparado, bloqueio, erros, resistidos, mínimo, média, máximo). Clique no
  título de uma coluna para ordenar; **Principais / Todas as colunas** escolhe
  quantas aparecem.
- **Linha do tempo**, embaixo das skills: o dano por segundo de cada jogador
  com o HP do chefe e o ping; os buffs e debuffs do jogador escolhido e os
  debuffs no alvo, com o tempo ativo de cada um; e as skills que ele usou, cada
  uso no tempo. Tudo no mesmo eixo: passar o mouse marca o momento em todas as
  partes.
- **Cura** e **Dano recebido** (só de monstros), por jogador.
- **Print** copia uma imagem da luta para colar com Ctrl + V e salva em
  `Imagens\Kerub`. **Copiar resumo** dá uma linha para colar no chat.

### Client

- **Ao vivo**: a luta de agora, com o HP do chefe e o tempo para ele morrer no
  DPS atual. Em cima, o que medir (**Chefe / Todos / Boneco**) e **Zerar
  luta**.
- **Histórico**: toda luta de 5 segundos ou mais fica gravada quando acaba, ao
  zerar, ao trocar de zona e ao fechar o Kerub: as de chefe, as de boneco de
  treino e as **lutas comuns** (monstros, masmorra diária, missões). Numa
  dungeon, a luta comum é a passagem inteira, do primeiro ao último golpe; fora
  dela, golpes com até 1 minuto de intervalo viram uma luta. Chefes seguidos da
  mesma dungeon aparecem juntos, com o tempo do primeiro ao último. Os filtros
  escondem as lutas comuns ou as de boneco.
- **Recordes**: seu melhor DPS e a luta mais rápida de cada chefe, por
  personagem (só lutas em que o chefe morreu).
- **Personagens**: digite um nome na busca da barra de cima e aperte Enter (a
  região fica no menu ao lado). Abre a página do personagem: equipamento com os
  atributos de cada item, skills, as tabelas Daevanion, os atributos na roda do
  jogo (ou em lista), títulos e aparência. Os dados vêm do site oficial do
  AION 2 (aion2.plaync.com), em português. A página fica guardada e abre na
  hora da próxima vez (atualiza sozinha depois de 10 minutos, ou no botão ↻).
  Favoritos e vistos por último ficam em **Personagens → Procurar**.
- **Mapa**: o mapa de Atreia com monstros, vilas, portais e recursos, com
  busca. Precisa de internet para as imagens do mapa.
- **Personalizar**: liga e desliga o overlay, escolhe as colunas dele, o número
  de jogadores, o tempo para o chefe morrer e a cor de cada classe (com aviso
  quando a cor deixa o texto branco difícil de ler). **Texto** muda o tamanho
  de todas as letras.
- A barra de cima mostra se o AION 2 está aberto e o ping com o servidor, tem
  voltar/avançar (também Alt + setas) e a busca de personagem. Arraste por ela
  para mover a janela; clique duas vezes para maximizar.
- Fechar o client fecha o Kerub. Para tirar da frente, minimize.

### Overlay

- Cada linha mostra as colunas escolhidas no client: DPS, parte do dano, dano,
  crítico, cura feita, cura recebida e dano recebido de monstros.
- Clique num jogador para ver as skills dele embaixo; clique de novo para
  fechar.
- **Chefe / Todos / Boneco**: qual alvo medir (o mesmo do client).
- Ao lado do tempo da luta, o ping com o servidor (em vermelho a partir de
  150 ms).
- A câmera tira um print do overlay: vai para a área de transferência e para
  `Imagens\Kerub`.
- **↺** zera a luta. O botão de janela traz o client para a frente. **✕**
  desliga o overlay (o client liga de novo).
- **Aa** muda o tamanho do texto (também com Ctrl + roda do mouse).
- **◐** deixa o fundo mais transparente a cada clique (90%, 80%… até 50%) e
  depois volta ao normal. O texto continua sólido.
- **Del** esconde e mostra o overlay. Só funciona com o jogo ou o Kerub em
  primeiro plano, e o jogo continua recebendo o Del.
- Arraste clicando em qualquer lugar fora das linhas; o cadeado trava a
  posição, que fica salva. A largura muda pelo canto inferior direito.

## Onde ficam os dados

Tudo fica em `%APPDATA%\local.kerub\historico.db` (SQLite), junto com os
personagens favoritos e vistos. As 1000 lutas de chefe e de boneco mais novas
(e as 500 lutas comuns mais novas) guardam todos os detalhes; as mais antigas
ficam só com o resumo, que é o que os recordes usam. Os ícones das skills vêm
do site oficial do jogo; sem internet aparece um símbolo no lugar.

## Compilar

Precisa de [Rust](https://rustup.rs) (stable), do Visual Studio Build Tools
(C++) e do Git.

```powershell
git clone https://github.com/londarks/Kerub.git
cd Kerub
.\build.ps1
.\dist\kerub.exe
```

O motor de captura (veja **Créditos**) fica numa pasta ao lado,
`..\A2Tools-DPS-Meter`. Se ela não existir, o `build.ps1` baixa a versão com
que o Kerub foi testado. Depois ele aplica as correções da pasta `patches\` no
motor, compila e copia o exe para `dist\`. A pasta `target\` é o cache do
compilador: se apagar, nada quebra, só o próximo build demora mais.

Em desenvolvimento, `cargo run` roda sem pedir administrador. Para ele
capturar, abra o terminal como administrador. `cargo test` roda os testes.


## Créditos e licença

A captura dos pacotes, o parser do protocolo e o cálculo do dano vêm do
[A2Tools DPS Meter](https://github.com/taengu/A2Tools-DPS-Meter), usado como
biblioteca (sem a parte online) e com as correções da pasta `patches\`. Ele é
GPL-3.0, e por isso o Kerub também é: veja [LICENSE](LICENSE).

O Kerub é um projeto de fã, sem ligação com a NCSOFT. AION é marca da NCSOFT;
os nomes, ícones e imagens do jogo são dela.
