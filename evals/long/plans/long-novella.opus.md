# Plan: *Skerrow* novella (12 chapters)

## 1. Goal
A finished 12-chapter mystery novella set on Skerrow in January 1974, told in close third person through Isla Mackay. Each chapter is saved as `chapters/01.md` … `chapters/12.md`. The mystery is fully solved by the end. The ferry returns, the page-tearer is named with a reason, Callum is cleared, and Isla chooses to stay.

## 2. Done means
- Exactly 12 files exist, `chapters/01.md` to `chapters/12.md`. Check: `ls chapters/`
- Each file is 1,200–1,800 words. Check: `wc -w chapters/*.md`
- Each file starts with `# Chapter N: Title`.
- Every scene is in Isla's point of view, third person, past tense.
- Chapter 12 contains the ferry's return, Mairi named as the page-tearer with her reason, Callum cleared, and Isla's decision to stay.
- No name variants appear. Check: `grep -n -i "thomas\|mary\|ewan\|calum" chapters/*.md` returns nothing.

## 3. Fixed facts (do not change)
- **Place:** Skerrow has one village, **Kilbrae**, which has the harbour, **the Anchor** inn, the post office and Isla's surgery. The **Skerrow Head lighthouse** is a single-keeper station 2 miles north of Kilbrae. It has an interior iron spiral stair of 74 steps. There are no assistant keepers.
- **No police on the island.** The nearest police are in Oban. The mainland telephone line fails on day 1 and is restored on day 7, Sunday 20 Jan.
- **Dates:** The storm and the ferry stoppage begin Monday 14 Jan 1974. The ferry is stopped for nine days, 14–22 Jan. It returns Wednesday 23 Jan, in chapter 12.
- **Harbour argument:** Monday 14 Jan, before the storm closed in. Callum wanted to sell the Reid croft land at Skerrow Head to Euan's oil company, **Caledonian Exploration**, and Tomas refused. Several people witnessed it.
- **The truth of the death, night of Tuesday 15 Jan:**
  - Tomas had angina. Isla prescribed his glyceryl trinitrate (GTN) tablets.
  - **Mairi Sutherland** had visited him most nights for two years, secretly. She was also telling him the contents of private telegrams. That included the Northern Lighthouse Board telegram saying the light would be automated in spring and Tomas retired, and Euan's company telegrams.
  - Tomas logged everything meticulously, including "M.S. arr./dep." times and what she told him.
  - Mairi left at **22:15**.
  - Tomas wrote his last entry at **22:30**: "Lamp trimmed. Chest bad again."
  - He had a cardiac attack on the stair, fell, and died around **22:45**. The death was an accident.
  - Mairi came back at **23:00** because she had forgotten her gloves. She found him dead and tore out the pages for **8–15 Jan**, then left.
  - **Callum** left the Anchor at **23:20**, after witnesses saw him there all evening. He walked up to make peace and found the body at **23:40**.
- **Mairi's reason:** the pages recorded her visits and her breaches of telegram secrecy. Exposure would cost her the post office and the island's only telephone, and would shame her. She hid the pages in the post office safe.
- **Euan's lie (red herring):** on night 2 he was at the north cliffs taking rock samples without landowner permission. Someone saw his torch near the lighthouse road. He lies about it until chapter 9.
- **Clearing Callum:** his Anchor alibi; Isla's findings of fall injuries with no defensive wounds and a GTN bottle in Tomas's pocket; and the 22:30 entry on the recovered pages.
- **Isla:** aged 34, born on Skerrow. She left Glasgow a year ago after a failed registrar post and a broken engagement. She had planned to leave Skerrow in spring.

## 4. Order of work
1. **Write `notes/outline.md` before any prose.** It must contain one paragraph per chapter, giving the date, the key events and the clue planted or revealed. Use this spine:
   1. 14 Jan: storm, ferry stops, the harbour argument, Isla's restlessness.
   2. 15 Jan night: called to the lighthouse, body, torn log.
   3. 16 Jan: examination, Callum under suspicion, villagers turn.
   4. 16–17 Jan: Mairi is helpful but evasive, and Euan is introduced.
   5. 17 Jan: torch-sighting rumour, and Euan lies.
   6. 18 Jan: Tomas's angina history, and gloves (Mairi's) are noticed missing or mentioned.
   7. 19 Jan: Callum's alibi checked and the croft dispute explained.
   8. 20 Jan: the phone line returns, Oban is told, and the automation telegram surfaces.
   9. 21 Jan: Euan confesses to the sampling, and his suspicion ends.
   10. 21 Jan: Isla reasons from the times and from Mairi's knowledge.
   11. 22 Jan: Mairi confesses and gives up the pages, which show 22:30.
   12. 23 Jan: ferry and police arrive, Callum cleared, Isla stays.
2. **Write chapters in order, one file each.** After each chapter, run `wc -w` on it. Add a line to `notes/progress.md` with the chapter number, word count, and any new minor names or facts introduced.
3. **After chapter 12, run all checks in section 2.** Fix any failure.
4. **Do one read-through for contradictions against section 3,** including times, dates and the step count.

## 5. Traps
- **Drifting facts after context loss.** Reread section 3 and `notes/progress.md` before each chapter.
- **Revealing the solution early.** Mairi's guilt must not be stated before chapter 11. Plant fair clues instead: her gloves, her knowledge of the automation telegram, and her nervousness about the safe.
- **Making Mairi a murderer, or Tomas's death a murder.** The death stays an accident.
- **Leaving Isla's point of view.** No scenes may happen without her present.
- **Anachronisms.** Avoid mobile phones and modern forensics. Use 1974 details: telegrams, paraffin, the three-day week and the oil-boom context.
- **Short chapters padded with weather.** Each chapter needs at least one scene that moves the mystery and one that moves Isla's decision.
- **Rushed ending.** Chapter 12 covers all four required outcomes in clear, separate beats.
- **Renaming or adding major characters.** Minor characters may be added, at most 6, and each must be logged in `notes/progress.md`.

## 6. When to stop
Stop when all 12 files exist, every check in section 2 passes, and the read-through finds no contradiction with section 3. Then report the per-chapter word counts and the total, and stop. Do not do further stylistic revision.
