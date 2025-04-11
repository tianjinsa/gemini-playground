/**
 * @fileoverview Defines an error boundary for handling various types of errors in the application.
 * It provides a set of predefined error codes and an ApplicationError class for consistent error handling.
 */

/**
 * Enumeration of error codes for different types of errors.
 * @enum {string}
 */
export const ErrorCodes = {
    // Audio related errors
    AUDIO_DEVICE_NOT_FOUND: 'AUDIO_DEVICE_NOT_FOUND',
    AUDIO_PERMISSION_DENIED: 'AUDIO_PERMISSION_DENIED',
    AUDIO_NOT_SUPPORTED: 'AUDIO_NOT_SUPPORTED',
    AUDIO_INITIALIZATION_FAILED: 'AUDIO_INITIALIZATION_FAILED',
    AUDIO_RECORDING_FAILED: 'AUDIO_RECORDING_FAILED',
    AUDIO_STOP_FAILED: 'AUDIO_STOP_FAILED',
    AUDIO_CONVERSION_FAILED: 'AUDIO_CONVERSION_FAILED',

    // WebSocket related errors
    WEBSOCKET_CONNECTION_FAILED: 'WEBSOCKET_CONNECTION_FAILED',
    WEBSOCKET_MESSAGE_FAILED: 'WEBSOCKET_MESSAGE_FAILED',
    WEBSOCKET_CLOSE_FAILED: 'WEBSOCKET_CLOSE_FAILED',

    // API related errors
    API_AUTHENTICATION_FAILED: 'API_AUTHENTICATION_FAILED',
    API_REQUEST_FAILED: 'API_REQUEST_FAILED',
    API_RESPONSE_INVALID: 'API_RESPONSE_INVALID',

    // General errors
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    INVALID_STATE: 'INVALID_STATE',
    INVALID_PARAMETER: 'INVALID_PARAMETER',

    // Video related errors
    VIDEO_DEVICE_NOT_FOUND: 'VIDEO_DEVICE_NOT_FOUND',
    VIDEO_PERMISSION_DENIED: 'VIDEO_PERMISSION_DENIED',
    VIDEO_NOT_SUPPORTED: 'VIDEO_NOT_SUPPORTED',
    VIDEO_CODEC_NOT_SUPPORTED: 'VIDEO_CODEC_NOT_SUPPORTED',
    VIDEO_START_FAILED: 'VIDEO_START_FAILED',
    VIDEO_STOP_FAILED: 'VIDEO_STOP_FAILED',

    // Screen sharing related errors
    SCREEN_DEVICE_NOT_FOUND: 'SCREEN_DEVICE_NOT_FOUND',
    SCREEN_PERMISSION_DENIED: 'SCREEN_PERMISSION_DENIED',
    SCREEN_NOT_SUPPORTED: 'SCREEN_NOT_SUPPORTED',
    SCREEN_START_FAILED: 'SCREEN_START_FAILED',
    SCREEN_STOP_FAILED: 'SCREEN_STOP_FAILED',
};

/**
 * Custom error class for application-specific errors.
 * Extends the built-in Error class and adds properties for error code, details, and timestamp.
 */
export class ApplicationError extends Error {
    /**
     * Creates a new ApplicationError.
     *
     * @param {string} message - The error message.
     * @param {string} [code=ErrorCodes.UNKNOWN_ERROR] - The error code.
     * @param {Object} [details={}] - Additional details about the error.
     */
    constructor(message, code = ErrorCodes.UNKNOWN_ERROR, details = {}) {
        super(message);
        this.name = 'ApplicationError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date().toISOString();

        // Ensure proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ApplicationError);
        }
    }

    /**
     * Converts the error object to a JSON representation.
     *
     * @returns {Object} The JSON representation of the error.
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            details: this.details,
            timestamp: this.timestamp,
            stack: this.stack
        };
    }
}

/**
 * @fileoverview 全局错误处理工具类，用于捕获和处理未捕获的异常
 */

/**
 * 错误边界类，提供全局错误捕获和处理能力
 */
export class ErrorBoundary {
    /**
     * 初始化错误边界
     * @param {Object} options - 配置选项
     * @param {Function} options.onError - 错误处理回调
     * @param {boolean} options.silent - 是否静默处理错误（不显示给用户）
     */
    constructor(options = {}) {
        this.options = {
            onError: (error) => console.error('Uncaught error:', error),
            silent: false,
            ...options
        };
        
        this.setupGlobalHandlers();
    }
    
    /**
     * 设置全局错误处理器
     * @private
     */
    setupGlobalHandlers() {
        // 处理未捕获的 Promise 异常
        window.addEventListener('unhandledrejection', (event) => {
            console.error('Unhandled Promise rejection:', event.reason);
            this.handleError(event.reason);
            event.preventDefault();
        });
        
        // 处理未捕获的 JS 异常
        window.addEventListener('error', (event) => {
            console.error('Uncaught error:', event.error);
            this.handleError(event.error || new Error(event.message));
            event.preventDefault();
        });
    }
    
    /**
     * 处理错误
     * @param {Error} error - 捕获的错误对象
     * @private
     */
    handleError(error) {
        this.options.onError(error);
        
        if (!this.options.silent) {
            this.showErrorToUser(error);
        }
    }
    
    /**
     * 向用户显示错误信息
     * @param {Error} error - 捕获的错误对象
     * @private
     */
    showErrorToUser(error) {
        // 创建错误提示元素
        const errorContainer = document.createElement('div');
        errorContainer.className = 'error-notification';
        errorContainer.innerHTML = `
            <div class="error-notification-content">
                <div class="error-notification-header">
                    <span class="error-title">出错了</span>
                    <button class="error-close">&times;</button>
                </div>
                <div class="error-notification-body">
                    <p>${error.message || '发生了未知错误'}</p>
                </div>
            </div>
        `;
        
        // 添加样式
        errorContainer.style.position = 'fixed';
        errorContainer.style.bottom = '20px';
        errorContainer.style.right = '20px';
        errorContainer.style.backgroundColor = '#f44336';
        errorContainer.style.color = 'white';
        errorContainer.style.padding = '15px';
        errorContainer.style.borderRadius = '4px';
        errorContainer.style.boxShadow = '0 2px 5px rgba(0,0,0,0.3)';
        errorContainer.style.zIndex = '9999';
        errorContainer.style.maxWidth = '300px';
        
        // 添加关闭按钮事件
        const closeButton = errorContainer.querySelector('.error-close');
        closeButton.style.cursor = 'pointer';
        closeButton.style.float = 'right';
        closeButton.style.fontSize = '20px';
        closeButton.style.fontWeight = 'bold';
        closeButton.style.marginLeft = '10px';
        
        closeButton.addEventListener('click', () => {
            document.body.removeChild(errorContainer);
        });
        
        // 添加到页面
        document.body.appendChild(errorContainer);
        
        // 5秒后自动消失
        setTimeout(() => {
            if (document.body.contains(errorContainer)) {
                document.body.removeChild(errorContainer);
            }
        }, 5000);
    }
    
    /**
     * 包装函数，为其添加错误处理
     * @param {Function} fn - 要包装的函数
     * @returns {Function} 包装后的函数
     */
    wrapFunction(fn) {
        return (...args) => {
            try {
                const result = fn(...args);
                
                // 处理返回的 Promise
                if (result instanceof Promise) {
                    return result.catch(error => {
                        this.handleError(error);
                        throw error;
                    });
                }
                
                return result;
            } catch (error) {
                this.handleError(error);
                throw error;
            }
        };
    }
}

// 创建默认的错误边界实例
const defaultErrorBoundary = new ErrorBoundary();

export default defaultErrorBoundary;