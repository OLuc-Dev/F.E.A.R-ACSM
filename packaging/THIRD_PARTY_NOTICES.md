# Third-party components in the F.E.A.R. app

F.E.A.R.'s own code is MIT-licensed (see LICENSE). The Windows app also ships
the components below, each under its own license. Most carry their full license
text inside the app folder (`_internal`, next to each package or in its
`*.dist-info`); the ones that don't are reproduced at the end of this file.

| Component | Used for | License |
| --- | --- | --- |
| Piper (`piper-tts`), with espeak-ng | F.E.A.R.'s voice | GPL-3.0-or-later |
| Piper voice `pt_BR-cadu-medium` | F.E.A.R.'s voice | trained on CC0 data |
| edge-tts | F.E.A.R.'s online voice (Microsoft's neural voices) | LGPL-3.0 |
| aiohttp | the online voice's connection | Apache-2.0 |
| faster-whisper | speech recognition | MIT |
| Whisper `small` model (OpenAI) | speech recognition | MIT |
| CTranslate2 | speech recognition | MIT |
| PyAV, with FFmpeg | reading recorded audio | BSD-3-Clause; FFmpeg LGPL-2.1+ |
| ONNX Runtime | voice, memory | MIT |
| MediaPipe Tasks Vision + gesture model | hand gestures | Apache-2.0 |
| all-MiniLM-L6-v2 | memory search | Apache-2.0 |
| ChromaDB | memory | Apache-2.0 |
| pywebview | the app window | BSD-3-Clause |

Because the app bundles GPL-3.0 components, the app as distributed is offered
under terms compatible with the GPL: its complete source code is public at
https://github.com/OLuc-Dev/F.E.A.R-ACSM, and the sources of Piper and espeak-ng
are at https://github.com/OHF-Voice/piper1-gpl and https://github.com/espeak-ng/espeak-ng
(edge-tts, LGPL-3.0: https://github.com/rany2/edge-tts).

The online voice sends the text of each sentence F.E.A.R. says to Microsoft's
speech service (the one Edge's "Read aloud" uses); it can be turned off in
Configurações → Comportamento → Voz, and then speech is made only on this computer.

## License texts

### CTranslate2

```
MIT License

Copyright (c) 2018-     SYSTRAN.
Copyright (c) 2019-     The OpenNMT Authors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Whisper `small` model (OpenAI; CTranslate2 conversion by SYSTRAN)

```
MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
