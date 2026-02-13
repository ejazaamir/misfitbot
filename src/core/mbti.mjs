export const MBTI_QUESTIONS = [
  { axis: "ei", agree: "E", text: "I feel energized after spending time with a lot of people." },
  { axis: "ei", agree: "I", text: "I usually need quiet time alone to recharge after social events." },
  { axis: "ei", agree: "E", text: "I think out loud and process ideas by talking." },
  { axis: "ei", agree: "I", text: "I prefer to think things through internally before speaking." },
  { axis: "sn", agree: "S", text: "I trust practical experience more than abstract theory." },
  { axis: "sn", agree: "N", text: "I enjoy exploring patterns and hidden meanings." },
  { axis: "sn", agree: "S", text: "I focus more on concrete details than future possibilities." },
  { axis: "sn", agree: "N", text: "I often imagine multiple future scenarios." },
  { axis: "tf", agree: "T", text: "I prioritize logic and consistency when making decisions." },
  { axis: "tf", agree: "F", text: "I prioritize people and harmony when making decisions." },
  { axis: "tf", agree: "T", text: "I am comfortable giving blunt, direct feedback." },
  { axis: "tf", agree: "F", text: "I naturally consider how decisions affect others emotionally." },
  { axis: "jp", agree: "J", text: "I like clear plans and closure before moving forward." },
  { axis: "jp", agree: "P", text: "I prefer flexibility and keeping options open." },
  { axis: "jp", agree: "J", text: "Deadlines and structure help me stay productive." },
  { axis: "jp", agree: "P", text: "I do my best work when I can adapt as I go." },
];

export const MBTI_TYPE_SUMMARIES = {
  INTJ: "Strategic and independent. Focuses on long-term systems, planning, and improvement.",
  INTP: "Analytical and curious. Loves frameworks, logic, and understanding how things work.",
  ENTJ: "Decisive and goal-driven. Natural organizer who leads with strategy and efficiency.",
  ENTP: "Inventive and energetic. Enjoys ideas, debate, and exploring unconventional solutions.",
  INFJ: "Insightful and principled. Balances vision with empathy and meaning.",
  INFP: "Idealistic and reflective. Guided by values, authenticity, and personal meaning.",
  ENFJ: "Warm and motivating. Reads people well and brings groups together around shared goals.",
  ENFP: "Expressive and imaginative. Finds possibilities quickly and inspires momentum.",
  ISTJ: "Dependable and methodical. Values order, responsibility, and proven approaches.",
  ISFJ: "Supportive and detail-aware. Protects stability and cares deeply for people.",
  ESTJ: "Structured and practical. Keeps operations running with clarity and accountability.",
  ESFJ: "Loyal and community-minded. Organizes people and resources to support others.",
  ISTP: "Calm and hands-on. Solves problems quickly through practical experimentation.",
  ISFP: "Quiet and adaptable. Values freedom, aesthetics, and lived experience.",
  ESTP: "Bold and action-oriented. Thrives in fast decisions and real-world challenges.",
  ESFP: "Social and spontaneous. Brings energy, warmth, and engagement to the moment.",
};

export const MBTI_AXIS_INFO = {
  ei: { positive: "E", negative: "I", label: "Energy (E/I)" },
  sn: { positive: "S", negative: "N", label: "Information (S/N)" },
  tf: { positive: "T", negative: "F", label: "Decisions (T/F)" },
  jp: { positive: "J", negative: "P", label: "Lifestyle (J/P)" },
};

