import type { Question, Subject } from '../types';

interface BundledStorePayload {
  version: number;
  updatedAt: string;
  subjects: Subject[];
  questions: Question[];
}

// <BUNDLED_JSON_START>
const BUNDLED_DATA: BundledStorePayload = {
  "version": 1795667200000,
  "updatedAt": "2026-11-27T00:00:00.000Z",
  "subjects": [
    {
      "id": "sub-bundled-1",
      "name": "ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី",
      "type": "mcq",
      "isActive": true,
      "order": 0
    }
  ],
  "questions": [
    {
      "id": "q-bundled-1",
      "subject": "ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី",
      "type": "mcq",
      "question": "តើមន្ត្រីរាជការស៊ីវិលអាចទទួលបានច្បាប់ឈប់ប្រចាំឆ្នាំចំនួនប៉ុន្មានថ្ងៃនៃថ្ងៃធ្វើការ ប្រសិនបើមន្ត្រីរាជការនោះបានបម្រើការងារចំនួន ២ ឆ្នាំជាប់គ្នា?",
      "options": [
        "ក. ២០ (ម្ភៃ) ថ្ងៃនៃថ្ងៃធ្វើការ",
        "ខ. ២៥ (ម្ភៃប្រាំ) ថ្ងៃនៃថ្ងៃធ្វើការ",
        "គ. ៣០ (សាមសិប) ថ្ងៃនៃថ្ងៃធ្វើការ",
        "ឃ. ៣៥ (សាមសិបប្រាំ) ថ្ងៃនៃថ្ងៃធ្វើការ"
      ],
      "correct": 2,
      "answer": "យោង ៖ អនុក្រឹត្យស្ដីពីការគ្រប់គ្រងការឈប់របស់មន្ត្រីរាជការស៊ីវិល។",
      "isActive": true,
      "order": 1
    },
    {
      "id": "q-bundled-2",
      "subject": "ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី",
      "type": "short",
      "question": "តើរដ្ឋធម្មនុញ្ញជាអ្វី?",
      "answer": "រដ្ឋធម្មនុញ្ញគឺជាច្បាប់កំពូលនៃព្រះរាជាណាចក្រកម្ពុជា។ ច្បាប់ និងសេចក្តីសម្រេចទាំងឡាយនៃស្ថាប័ននានារបស់រដ្ឋ ត្រូវតែស្របទៅនឹងរដ្ឋធម្មនុញ្ញជាដាច់ខាត។",
      "isActive": true,
      "order": 2
    },
    {
      "id": "q-bundled-3",
      "subject": "ចំណេះដឹងទូទៅ និងច្បាប់រដ្ឋប្បវេណី",
      "type": "explanation",
      "question": "នីតិរដ្ឋ",
      "answer": "រដ្ឋដែលគ្រប់គ្រងដោយគោរពតាមគោលការណ៍ច្បាប់ ដោយគ្មានបុគ្គលណាម្នាក់នៅពីលើច្បាប់ឡើយ។",
      "isActive": true,
      "order": 3
    }
  ]
};
// <BUNDLED_JSON_END>

export const BUNDLED_VERSION: number = BUNDLED_DATA.version;
export const BUNDLED_UPDATED_AT: string = BUNDLED_DATA.updatedAt;
export const BUNDLED_SUBJECTS: Subject[] = BUNDLED_DATA.subjects;
export const BUNDLED_QUESTIONS: Question[] = BUNDLED_DATA.questions;
