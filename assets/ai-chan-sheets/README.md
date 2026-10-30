# AI 娘設定圖

這裡的圖不是本 repo 畫的。來源是 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets)，
角色形象與原始設定出自 [ZipZipPipe](https://space.bilibili.com/4168597)。

## 收了什麼

- 11 個角色，每人 5 張 `便于查看/` 的圖：全板總覽、三視圖、表情、服裝、道具。
- `完整设定图_浏览预览.jpg` **沒有收**：全板總覽是同一張圖的 4000px 版本，比瀏覽預覽小，
  而且 `image_gen` 用的是三視圖，不需要再放一份大檔。
- `characters.json` 是角色對照表：代號、中文名、別名、資料夾、5 張圖的相對路徑。
  `plugins/dc-agent-presets/dc-draw-image.mjs` 只讀這份；要換圖或加角色就改這裡。

## 角色對照

| 代號 | 名字／別名 | 資料夾 |
| --- | --- | --- |
| `glm` | 智谱 GLM 娘、阔耳狐娘、GLM娘 | `01_智谱GLM娘_阔耳狐娘` |
| `gpt` | GPT 娘、白龙娘、OpenAI娘 | `02_GPT娘_白龙娘` |
| `deepseek` | DeepSeek 娘、鲸鱼娘、大肥魚、自己 | `03_DeepSeek娘_鲸鱼娘` |
| `ernie` | 文心一言娘、文心娘、百度娘、蓝发轮椅少女 | `04_文心一言娘` |
| `qwen` | 通义千问娘、Qwen娘、千问娘、阿里娘 | `05_通义千问娘_Qwen` |
| `kimi` | Kimi 娘、月之暗面娘、Moonshot娘 | `06_Kimi娘_Moonshot` |
| `doubao` | 豆包 Seed 娘、豆包娘、Seed娘、紫发高马尾 | `07_豆包Seed娘` |
| `minimax` | MiniMax 娘、海螺 AI 娘、海螺娘 | `08_MiniMax娘_海螺AI` |
| `grok` | Grok 娘、金发吸血鬼 | `09_Grok娘_xAI` |
| `gemini` | Gemini 娘、四角星猫耳 | `10_Gemini娘` |
| `claude` | Claude 娘、克劳德娘、橘发菊花 | `11_Claude娘_Anthropic` |

中文名、英文名、資料夾名與別名都可比對；大小寫、空白、全半形與括號不影響。
`self`、`自己`、`大肥魚` 都指向 `deepseek`。

## 授權

- 補全工作依 **CC BY-NC-SA 4.0**（姓名標示─非商業性─相同方式分享）釋出。
  授權全文：https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode
- 用途：畫指定角色時，把該角色的三視圖當 `generate_image` 的參考圖。
- 非商業：這個 repo 與 bot 沒有營利；要商業使用這些圖，得另外取得授權。
- 改圖或再散布時，記得保留上面的姓名標示與相同授權。
