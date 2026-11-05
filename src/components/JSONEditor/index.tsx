import 'ace-builds/src-min-noconflict/ace';
import 'ace-builds/src-min-noconflict/mode-json';
import 'ace-builds/src-min-noconflict/theme-dracula';
import type { HTMLAttributes } from 'react';
import AceEditor from 'react-ace';
interface JSONEditorProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  value: string;
  onUpdate: (value: string) => void;
  /** The text box id, for a <label>. */
  inputId?: string;
  /** Accessible name for the editor. */
  label?: string;
}

const JSONEditor = ({
  name,
  value,
  onUpdate,
  onBlur,
  inputId,
  label,
}: JSONEditorProps) => {
  return (
    <div className="w-full overflow-hidden rounded-md">
      <AceEditor
        mode="json"
        theme="dracula"
        onChange={onUpdate}
        name={name}
        editorProps={{ $blockScrolling: true }}
        // Ace's hidden text box names itself after the cursor row unless given a label.
        setOptions={label ? { textInputAriaLabel: label } : undefined}
        onLoad={(editor) => {
          if (inputId) {
            editor.textInput.getElement().id = inputId;
          }
        }}
        value={value}
        onBlur={onBlur}
        height="300px"
        width="100%"
      />
    </div>
  );
};

export default JSONEditor;
