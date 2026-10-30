// Every user-visible string lives here (SPEC section 14). `{x}` marks a value filled in by `fill`.
export const ar = {
  appName: 'تطبيق مندوب المبيعات',
  common: { cancel: 'إلغاء', back: 'رجوع', loading: 'جارٍ التحميل…' },
  login: {
    title: 'تسجيل الدخول',
    passwordLabel: 'كلمة المرور',
    submit: 'دخول',
    required: 'أدخل كلمة المرور',
    wrongPassword: 'كلمة المرور غير صحيحة',
    tooMany: 'محاولات كثيرة. حاول بعد {minutes} دقيقة.',
    offline: 'لا يوجد اتصال بالإنترنت. تسجيل الدخول على هذا الجهاز يحتاج إنترنت.',
    failed: 'تعذّر تسجيل الدخول. حاول مرة أخرى.',
    replaceTitle: 'يوجد جهاز آخر مفعّل',
    replaceBody:
      'الجهاز "{name}" مفعّل حالياً. إذا تابعت سيتم إيقافه ومسح بياناته عند اتصاله القادم.',
    replaceConfirm: 'تابع وأوقف الجهاز الآخر',
  },
  setPin: {
    title: 'اختر رمز PIN',
    hint: 'من 4 إلى 6 أرقام. ستستخدمه كل يوم لفتح التطبيق.',
    confirmTitle: 'أعد إدخال الرمز',
    mismatch: 'الرمزان غير متطابقين. حاول من جديد.',
    save: 'حفظ الرمز',
    failed: 'تعذّر حفظ الرمز. تأكد من الاتصال بالإنترنت.',
  },
  lock: {
    title: 'التطبيق مقفل',
    hint: 'أدخل رمز PIN',
    wrong: 'الرمز غير صحيح',
    lockedFor: 'انتظر {minutes} دقيقة قبل المحاولة من جديد.',
    needPassword: 'محاولات خاطئة كثيرة. أدخل كلمة المرور للمتابعة.',
    unlockWithPassword: 'فتح بكلمة المرور',
  },
  pad: { delete: 'حذف', confirm: 'تأكيد' },
  nav: {
    home: 'الرئيسية',
    catalog: 'الكتالوج',
    customers: 'الزبائن',
    invoices: 'الفواتير',
    stock: 'المخزون',
    reports: 'التقارير',
    settings: 'الإعدادات',
    menu: 'القائمة الرئيسية',
  },
  header: {
    online: 'متصل',
    offline: 'بدون اتصال',
    lock: 'قفل التطبيق',
    syncSoon: 'المزامنة تبدأ في مرحلة قادمة',
  },
  banner: {
    install:
      'لحماية بياناتك افتح التطبيق من أيقونته على الشاشة الرئيسية: اضغط مشاركة ثم "إضافة إلى الشاشة الرئيسية".',
    sessionExpired: 'انتهت جلسة الدخول. سجّل الدخول من جديد عندما يتوفر الإنترنت.',
    clockOff: 'ساعة الجهاز غير مضبوطة. صحّح التاريخ والوقت حتى تكون الفواتير سليمة.',
  },
  empty: {
    home: {
      title: 'مرحباً',
      hint: 'ستظهر هنا أرقام اليوم عند إضافة المنتجات والزبائن.',
      next: 'ابدأ بإضافة المنتجات من ملف Excel',
    },
    catalog: {
      title: 'لا توجد منتجات بعد',
      hint: 'سيظهر الكتالوج هنا.',
      next: 'استيراد المنتجات من ملف Excel',
    },
    customers: {
      title: 'لا يوجد زبائن بعد',
      hint: 'أضف زبائنك واحداً واحداً.',
      next: 'إضافة أول زبون',
    },
    invoices: {
      title: 'لا توجد فواتير بعد',
      hint: 'تظهر الفواتير هنا بعد أول عملية بيع.',
      next: 'ابدأ عملية بيع',
    },
    stock: {
      title: 'لا توجد حركة مخزون',
      hint: 'استلام البضاعة والجرد يظهران هنا.',
      next: 'استلام بضاعة',
    },
    reports: {
      title: 'لا توجد تقارير بعد',
      hint: 'التقارير تحتاج إلى مبيعات مسجّلة.',
      next: 'ابدأ عملية بيع',
    },
    soon: 'هذه الميزة قيد التطوير',
  },
  settings: {
    title: 'الإعدادات',
    device: 'الجهاز',
    storage: 'التخزين الدائم',
    storageOn: 'مفعّل',
    storageOff: 'غير مفعّل (قد يمسح Safari البيانات إذا لم يُثبَّت التطبيق)',
    lockNow: 'قفل الآن',
    changePin: 'تغيير رمز PIN',
    logout: 'تسجيل الخروج',
    logoutAll: 'تسجيل الخروج من كل الأجهزة',
    logoutFailed: 'تعذّر الاتصال. تسجيل الخروج يحتاج إنترنت.',
  },
} as const

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}
