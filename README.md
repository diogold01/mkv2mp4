# mkv2mp4

Aplicação desktop para Windows que converte arquivos `.mkv` para `.mp4` usando FFmpeg e FFprobe embutidos. O programa inspeciona cada arquivo para aplicar remux direto sem perda de qualidade (`-c copy`) quando os codecs são compatíveis, ou converter apenas faixas de áudio incompatíveis (DTS, FLAC, Opus) para AAC preservando o vídeo original.

![Interface do mkv2mp4](assets/preview.png)

## Como funciona

Os arquivos podem ser adicionados arrastando para a janela ou pelo seletor múltiplo. Antes da conversão, o FFprobe lista as faixas de áudio e legenda de cada vídeo para que o usuário escolha o que manter ou descartar (útil em arquivos dual áudio). Se faixas incompatíveis forem desmarcadas e restarem apenas codecs aceitos pelo contêiner MP4 (H.264/H.265 com AAC, AC3 ou MP3), a conversão ocorre por remux direto. Quando a recodificação completa é necessária ou selecionada, o vídeo é convertido para H.264 + AAC com opções de CRF (`18`, `23`, `28`) e preset (`fast`, `medium`, `slow`).

Legendas em texto são convertidas para `mov_text`, e legendas de imagem (PGS/VobSub) são sinalizadas e ignoradas para evitar falha no empacotamento MP4. A fila executa de 1 a 3 arquivos simultâneos exibindo progresso, velocidade e tempo restante estimado. Também há escolha de pasta de saída, renomeação ou sobrescrita de arquivos existentes, notificação ao término da fila e exclusão opcional do `.mkv` original mediante confirmação. As preferências são salvas em JSON no diretório `userData` do sistema.

## Stack

Desenvolvido em Electron (`contextIsolation: true`, `nodeIntegration: false`), Node.js (`child_process.spawn`), HTML, CSS e JavaScript puro. Os binários do FFmpeg e FFprobe são empacotados via `ffmpeg-static` e `ffprobe-static` com `asarUnpack`, dispensando instalação separada pelo usuário.

## Download

Os executáveis para Windows (x64) estão disponíveis na página de [Releases](https://github.com/diogold01/mkv2mp4/releases):

- `MKV2MP4-Setup-1.0.0.exe` (instalador NSIS)
- `MKV2MP4-1.0.0-portable.exe` (versão portátil)

## Desenvolvimento e build

Requer Node.js 18 ou superior:

```bash
npm install
npm start
```

Para gerar o instalador e o executável portátil na pasta `dist/`:

```bash
npm run build
```

Para compilar separadamente, use `npm run build:installer` ou `npm run build:portable`. Um modelo de workflow para GitHub Actions está disponível em `workflows/build.yml`.

## Licença

[MIT](LICENSE)
