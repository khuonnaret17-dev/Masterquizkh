import { Question, Subject, AppNotification } from '../types';
import {
  BUNDLED_VERSION,
  BUNDLED_UPDATED_AT,
  BUNDLED_SUBJECTS,
  BUNDLED_QUESTIONS,
} from '../data/bundledQuestions';

export const INITIAL_BUNDLED_VERSION: number = BUNDLED_VERSION;
export const INITIAL_BUNDLED_UPDATED_AT: string = BUNDLED_UPDATED_AT;

export const INITIAL_SUBJECTS: Subject[] = BUNDLED_SUBJECTS;

export const INITIAL_QUESTIONS: Question[] = BUNDLED_QUESTIONS;

export const INITIAL_NOTIFICATIONS: AppNotification[] = [
  {
    id: 'notif-1',
    message: 'សូមស្វាគមន៍មកកាន់ប្រព័ន្ធ "Master Quiz KH"! ប្រព័ន្ធគ្រប់គ្រង និងធ្វើតេស្តសមត្ថភាពត្រៀមប្រឡងក្របខ័ណ្ឌរដ្ឋ។',
    timestamp: new Date().toISOString(),
    type: 'success',
  },
  {
    id: 'notif-2',
    message: 'អ្នកគ្រប់គ្រង (Admin) អាចបង្កើតមុខវិជ្ជា និងបញ្ចូលវិញ្ញាសាថ្មីៗតាមរយៈផ្ទាំងគ្រប់គ្រង។',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    type: 'info',
  },
];
