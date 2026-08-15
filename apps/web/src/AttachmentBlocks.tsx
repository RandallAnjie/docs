import { mergeAttributes, Node } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Download, File, Music2, Trash2, Video } from 'lucide-react';

function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`;
}

function byteLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentAttributes(element: HTMLElement) {
  return {
    attachmentId: element.getAttribute('data-attachment-id') ?? '',
    byteSize: Number(element.getAttribute('data-byte-size') ?? 0),
    mimeType: element.getAttribute('data-mime-type') ?? 'application/octet-stream',
    name: element.getAttribute('data-name') ?? '附件',
  };
}

function commonAttachmentAttributes() {
  return {
    attachmentId: { default: '' },
    byteSize: { default: 0 },
    mimeType: { default: 'application/octet-stream' },
    name: { default: '附件' },
  };
}

function AttachmentNodeActions({ props }: { props: NodeViewProps }) {
  const attachmentId = String(props.node.attrs.attachmentId ?? '');
  return (
    <span className="rdocs-node-actions">
      <a href={attachmentUrl(attachmentId)} title="下载附件" aria-label="下载附件" download>
        <Download size={13} />
      </a>
      {props.editor.isEditable ? (
        <button type="button" title="从正文删除" onClick={props.deleteNode}>
          <Trash2 size={13} />
        </button>
      ) : null}
    </span>
  );
}

function FileAttachmentNodeView(props: NodeViewProps) {
  const attachmentId = String(props.node.attrs.attachmentId ?? '');
  const name = String(props.node.attrs.name ?? '附件');
  const mimeType = String(props.node.attrs.mimeType ?? 'application/octet-stream');
  const size = byteLabel(Number(props.node.attrs.byteSize ?? 0));
  const isPdf = mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
  return (
    <NodeViewWrapper className="rdocs-file-block" contentEditable={false} data-drag-handle>
      {isPdf ? (
        <iframe className="rdocs-pdf-preview" src={attachmentUrl(attachmentId)} title={name} />
      ) : null}
      <a href={attachmentUrl(attachmentId)} download>
        <span className="rdocs-file-block-icon">
          <File size={19} />
        </span>
        <span>
          <strong>{name}</strong>
          <small>{[size, mimeType].filter(Boolean).join(' · ')}</small>
        </span>
      </a>
      <AttachmentNodeActions props={props} />
    </NodeViewWrapper>
  );
}

function AudioAttachmentNodeView(props: NodeViewProps) {
  const attachmentId = String(props.node.attrs.attachmentId ?? '');
  const name = String(props.node.attrs.name ?? '音频');
  return (
    <NodeViewWrapper className="rdocs-media-block audio" contentEditable={false} data-drag-handle>
      <header>
        <span>
          <Music2 size={14} /> {name}
        </span>
        <AttachmentNodeActions props={props} />
      </header>
      <audio src={attachmentUrl(attachmentId)} controls preload="metadata" aria-label={name}>
        您的浏览器不支持音频播放。
      </audio>
    </NodeViewWrapper>
  );
}

function VideoAttachmentNodeView(props: NodeViewProps) {
  const attachmentId = String(props.node.attrs.attachmentId ?? '');
  const name = String(props.node.attrs.name ?? '视频');
  return (
    <NodeViewWrapper className="rdocs-media-block video" contentEditable={false} data-drag-handle>
      <header>
        <span>
          <Video size={14} /> {name}
        </span>
        <AttachmentNodeActions props={props} />
      </header>
      <video
        src={attachmentUrl(attachmentId)}
        controls
        preload="metadata"
        playsInline
        aria-label={name}
      >
        您的浏览器不支持视频播放。
      </video>
    </NodeViewWrapper>
  );
}

export const FileAttachmentBlock = Node.create({
  name: 'attachmentFile',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return commonAttachmentAttributes();
  },
  parseHTML() {
    return [{ tag: 'a[data-rdocs-attachment-file]', getAttrs: attachmentAttributes }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const attachmentId = String(node.attrs.attachmentId ?? '');
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-attachment-id': attachmentId,
        'data-byte-size': node.attrs.byteSize,
        'data-mime-type': node.attrs.mimeType,
        'data-name': node.attrs.name,
        'data-rdocs-attachment-file': '',
        download: '',
        href: attachmentUrl(attachmentId),
      }),
      String(node.attrs.name ?? '附件'),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentNodeView);
  },
});

function mediaBlock(name: 'attachmentAudio' | 'attachmentVideo') {
  const audio = name === 'attachmentAudio';
  return Node.create({
    name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
      return commonAttachmentAttributes();
    },
    parseHTML() {
      return [
        {
          tag: `figure[data-rdocs-${audio ? 'audio' : 'video'}-attachment]`,
          getAttrs: attachmentAttributes,
        },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      const attachmentId = String(node.attrs.attachmentId ?? '');
      return [
        'figure',
        mergeAttributes(HTMLAttributes, {
          'data-attachment-id': attachmentId,
          'data-byte-size': node.attrs.byteSize,
          'data-mime-type': node.attrs.mimeType,
          'data-name': node.attrs.name,
          [`data-rdocs-${audio ? 'audio' : 'video'}-attachment`]: '',
        }),
        [
          audio ? 'audio' : 'video',
          {
            controls: '',
            playsinline: audio ? undefined : '',
            preload: 'metadata',
            src: attachmentUrl(attachmentId),
          },
        ],
      ];
    },
    addNodeView() {
      return ReactNodeViewRenderer(audio ? AudioAttachmentNodeView : VideoAttachmentNodeView);
    },
  });
}

export const AudioAttachmentBlock = mediaBlock('attachmentAudio');
export const VideoAttachmentBlock = mediaBlock('attachmentVideo');

export const attachmentEditorBlocks = [
  FileAttachmentBlock,
  AudioAttachmentBlock,
  VideoAttachmentBlock,
];
