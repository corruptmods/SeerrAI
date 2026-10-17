import {
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/solid';

interface AlertProps {
  title?: React.ReactNode;
  type?: 'warning' | 'info' | 'error';
  children?: React.ReactNode;
}

const Alert = ({ title, children, type }: AlertProps) => {
  // Theme colours (tailwind.config.js). The pale text of dark mode would be
  // lost on a light page, so light mode has its own.
  let design = {
    bgColor: 'border border-warning backdrop-blur bg-warning-soft/20',
    titleColor: 'text-yellow-100 light:text-warning-text',
    textColor: 'text-yellow-300 light:text-warning-text',
    svg: <ExclamationTriangleIcon className="h-5 w-5" />,
  };

  switch (type) {
    case 'info':
      design = {
        bgColor: 'border border-info backdrop-blur bg-info-soft/20',
        titleColor: 'text-gray-100',
        textColor: 'text-default',
        svg: <InformationCircleIcon className="h-5 w-5" />,
      };
      break;
    case 'error':
      design = {
        bgColor: 'bg-danger',
        titleColor: 'text-red-100',
        textColor: 'text-red-300 light:text-red-100',
        svg: <XCircleIcon className="h-5 w-5" />,
      };
      break;
  }

  return (
    <div className={`mb-4 rounded-md p-4 ${design.bgColor}`} data-seerr="alert">
      <div className="flex">
        <div className={`flex-shrink-0 ${design.titleColor}`}>{design.svg}</div>
        <div className="ml-3">
          {title && (
            <div className={`text-sm font-medium ${design.titleColor}`}>
              {title}
            </div>
          )}
          {children && (
            <div className={`mt-2 text-sm first:mt-0 ${design.textColor}`}>
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Alert;
