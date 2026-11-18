const instructions = /(?:^|[;\s])(лист|sheet|колона|column)[\t ]*[:=][\t ]*(?:"([^"\n]+)"|“([^”\n]+)”|([^;\n]+))/giu;
const allowed = new Set(`анализ анализирай анализирайте обобщи обобщение резюме преглед дай направи изведи изчисли сметни покажи
 на от в и за със с по моля прикачения прикачената прикачен прикачена файла файл таблица таблицата данни данните
 csv xlsx колони колоните число числа числовите числови клетки клетките стойности стойностите
 статистика описателна обобщена броя брой празни празните сума сумата средна средно средната минимум минимума максимум максимума min max
 графика графиката диаграма диаграмата начертай създай експортирай експорт
 please analyze analyse summarize summarise summary descriptive statistics chart plot graph draw create calculate sum mean average
 minimum maximum count stats data table file attached spreadsheet numbers numeric missing blank rows columns the from for of and in by per`
  .trim().split(/\s+/));
function instruction(prompt, keys) {
  const match = [...prompt.matchAll(instructions)].find((entry) => keys.includes(entry[1].toLowerCase()));
  return (match?.[2] ?? match?.[3] ?? match?.[4])?.trim();
}
function supportsLocalTableAnalysis(prompt) {
  const request = prompt.replace(instructions, ' ').trim().toLowerCase();
  const words = request.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.every((word) => allowed.has(word));
}

export const withoutDirectives = (prompt) => prompt.replace(instructions, ' ');
export { instruction, supportsLocalTableAnalysis };
